
import {S3Client} from "@aws-sdk/client-s3";
import { PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

//Client configuration
const s3 = new S3Client({
    endpoint: process.env.IONOS_SERVICE_URL,
    region: process.env.IONOS_REGION,
    credentials: {
        accessKeyId: process.env.IONOS_ACCESS_KEY,
        secretAccessKey: process.env.IONOS_SECRET_KEY,
    },
    forcePathStyle: true,
});

const bucketName = process.env.IONOS_BUCKET_NAME;

//Helpers
function ensureConfigured(){
    const missing = ["IONOS_SERVICE_URL", "IONOS_REGION", "IONOS_ACCESS_KEY", "IONOS_SECRET_KEY", "IONOS_BUCKET_NAME"].filter((k)=>!process.env[k]);
    if(missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
}

//Operations
export async function uploadBuffer(key, buffer, contentType = "application/octet-stream"){
    await s3.send(new PutObjectCommand({Bucket: bucketName, Key: key, Body: buffer, ContentType: contentType}));
    return key;
};

export async function uploadStream(key, readableStream, contentType = "application/octet-stream"){
    await s3.send(new PutObjectCommand({Bucket: bucketName, Key: key, Body: readableStream, ContentType: contentType}));
    return key;
};

export async function downloadFile (key) {
const res = await s3.send(new GetObjectCommand({Bucket: bucketName, Key: key}));
return res.Body
};

export async function listFiles(prefix = ""){
const res = await s3.send(new ListObjectsV2Command({Bucket: bucketName, Prefix: prefix}));
return res.Contents ?? [];
};

export async function deleteFile(key){
    await s3.send(new DeleteObjectCommand({Bucket: bucketName, Key: key}));
};

export async function getPresignedUrl(key, expiresIn = 3600){
    return getSignedUrl(s3, new GetObjectCommand({Bucket: bucketName, Key: key}), {expiresIn});
}

//Connection test

export async function testConnection(){
ensureConfigured();
await s3.send(new ListObjectsV2Command({Bucket: bucketName, MaxKeys: 1}));
return true;
};