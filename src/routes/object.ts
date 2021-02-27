import { FastifyInstance, RequestGenericInterface } from 'fastify'
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import dotenv from 'dotenv'

import { getOwner, getPostgrestClient } from '../utils'

dotenv.config()

const {
  REGION: region,
  PROJECT_REF: projectRef,
  BUCKET_NAME: globalS3Bucket,
  ANON_KEY: anonKey,
} = process.env

const client = new S3Client({ region, runtime: 'node' })
interface requestGeneric extends RequestGenericInterface {
  Params: {
    bucketName: string
    '*': string
  }
}

type Bucket = {
  id: string
  name: string
  owner: string
  createdAt: string
  updatedAt: string
}

type Obj = {
  id: string
  bucketId: string
  name: string
  owner: string
  createdAt: string
  updatedAt: string
  lastAccessedAt: string
  metadata?: Record<string, unknown>
  buckets?: Bucket
}

// @todo better error handling everywhere
export default async function routes(fastify: FastifyInstance) {
  fastify.get<requestGeneric>('/object/:bucketName/*', async (request, response) => {
    const authHeader = request.headers.authorization
    if (!authHeader || !anonKey) {
      return response.status(403).send('Go away')
    }
    const jwt = authHeader.substring('Bearer '.length)

    const postgrest = getPostgrestClient(jwt)

    const { bucketName } = request.params
    const objectName = request.params['*']

    const { data: results, error } = await postgrest
      .from<Obj>('objects')
      .select('*, buckets(*)')
      .match({
        name: objectName,
        'buckets.name': bucketName,
      })
      .single()

    console.log(error)
    // console.log(results)
    if (!results?.buckets) {
      // @todo why is this check necessary?
      // if corresponding bucket is not found, i want the object also to not be returned
      // is it cos of https://github.com/PostgREST/postgrest/issues/1075 ?
      return response.status(404).send('not found')
    }

    // send the object from s3
    const s3Key = `${projectRef}/${bucketName}/${objectName}`
    console.log(s3Key)
    const command = new GetObjectCommand({
      Bucket: globalS3Bucket,
      Key: s3Key,
    })
    const data = await client.send(command)
    console.log('done s3')

    // @todo stream the response back instead of awaiting from s3 and sending back
    return response
      .status(data.$metadata.httpStatusCode ?? 200)
      .header('content-type', data.ContentType)
      .send(data.Body)
  })

  // @todo support multiple uploads
  fastify.post<requestGeneric>('/object/:bucketName/*', async (request, response) => {
    // @todo should upsert work?
    // check if the user is able to insert that row
    const authHeader = request.headers.authorization
    if (!authHeader || !anonKey) {
      return response.status(403).send('Go away')
    }
    const jwt = authHeader.substring('Bearer '.length)
    const data = await request.file()

    const { bucketName } = request.params
    const objectName = request.params['*']

    const postgrest = getPostgrestClient(jwt)
    const owner = await getOwner(jwt)
    // @todo how to merge these into one query?
    // i can create a view and add INSTEAD OF triggers..is that the way to do it?
    // @todo add unique constraint for just bucket names
    const { data: bucket, error: bucketError } = await postgrest
      .from('buckets')
      .select('id')
      .eq('name', bucketName)
      .single()
    if (bucketError) throw bucketError
    console.log(bucket)

    const { data: results, error } = await postgrest
      .from<Obj>('objects')
      .insert(
        [
          {
            name: objectName,
            owner: owner,
            bucketId: bucket.id,
            metadata: {
              mimetype: data.mimetype,
            },
          },
        ],
        {
          returning: 'minimal',
        }
      )
      .single()
    console.log(results, error)
    if (error) {
      return response.status(403).send('Go away')
    }

    // if successfully inserted, upload to s3
    const s3Key = `${projectRef}/${bucketName}/${objectName}`

    const paralellUploads3 = new Upload({
      client,
      params: {
        Bucket: globalS3Bucket,
        Key: s3Key,
        /* @ts-expect-error: https://github.com/aws/aws-sdk-js-v3/issues/2085 */
        Body: data.file,
        ContentType: data.mimetype,
      },
    })

    const uploadResult = await paralellUploads3.done()

    return response.status(uploadResult.$metadata.httpStatusCode ?? 200).send({
      Key: s3Key,
    })
  })

  fastify.put<requestGeneric>('/object/:bucketName/*', async (request, response) => {
    // check if the user is able to update the row
    const authHeader = request.headers.authorization
    if (!authHeader || !anonKey) {
      return response.status(403).send('Go away')
    }
    const jwt = authHeader.substring('Bearer '.length)
    const data = await request.file()

    const { bucketName } = request.params
    const objectName = request.params['*']

    const postgrest = getPostgrestClient(jwt)
    const owner = await getOwner(jwt)
    // @todo how to merge these into one query?
    // i can create a view and add INSTEAD OF triggers..is that the way to do it?
    // @todo add unique constraint for just bucket names
    const { data: bucket, error: bucketError } = await postgrest
      .from('buckets')
      .select('id')
      .eq('name', bucketName)
      .single()
    if (bucketError) throw bucketError
    console.log(bucket)

    const { data: results, error } = await postgrest
      .from<Obj>('objects')
      .update(
        {
          lastAccessedAt: new Date().toISOString(),
          owner,
          metadata: {
            mimetype: data.mimetype,
          },
        },
        { returning: 'minimal' }
      )
      .match({ bucketId: bucket.id, name: objectName })
      .limit(1)

    console.log('results: ', results)
    console.log('error: ', error)
    if (error || (results && results.length === 0)) {
      return response.status(403).send('Go away')
    }

    // if successfully inserted, upload to s3
    const s3Key = `${projectRef}/${bucketName}/${objectName}`

    // @todo adding contentlength metadata will be harder since everything is streams
    const paralellUploads3 = new Upload({
      client,
      params: {
        Bucket: globalS3Bucket,
        Key: s3Key,
        /* @ts-expect-error: https://github.com/aws/aws-sdk-js-v3/issues/2085 */
        Body: data.file,
        ContentType: data.mimetype,
      },
    })

    const uploadResult = await paralellUploads3.done()

    return response.status(uploadResult.$metadata.httpStatusCode ?? 200).send({
      Key: s3Key,
    })
  })

  // @todo support multiple deletes
  fastify.delete<requestGeneric>('/object/:bucketName/*', async (request, response) => {
    // check if the user is able to insert that row
    const authHeader = request.headers.authorization
    if (!authHeader || !anonKey) {
      return response.status(403).send('Go away')
    }
    const jwt = authHeader.substring('Bearer '.length)

    const { bucketName } = request.params
    const objectName = request.params['*']

    const postgrest = getPostgrestClient(jwt)
    // @todo how to merge these into one query?
    // i can create a view and add INSTEAD OF triggers..is that the way to do it?
    // @todo add unique constraint for just bucket names
    const { data: bucket, error: bucketError } = await postgrest
      .from('buckets')
      .select('id')
      .eq('name', bucketName)
      .single()
    if (bucketError) throw bucketError
    console.log(bucket)

    const { data: results, error } = await postgrest.from<Obj>('objects').delete().match({
      name: objectName,
      bucketId: bucket.id,
    })

    console.log(results, error)
    if (error || (results && results.length === 0)) {
      return response.status(403).send('Go away')
    }

    // if successfully deleted, delete from s3 too
    const s3Key = `${projectRef}/${bucketName}/${objectName}`

    const command = new DeleteObjectCommand({
      Bucket: globalS3Bucket,
      Key: s3Key,
    })
    await client.send(command)
    console.log('done s3')

    return response.status(200).send('Deleted')
  })
}
