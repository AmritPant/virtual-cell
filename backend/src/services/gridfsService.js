import { GridFSBucket, ObjectId } from "mongodb";
import mongoose from "mongoose";
import axios from "axios";

let proteinBucket = null;

export function initGridFs() {
  if (proteinBucket) return proteinBucket;
  proteinBucket = new GridFSBucket(mongoose.connection.db, { bucketName: "proteinStructures" });
  return proteinBucket;
}

export async function streamRemoteFileToGridFs(fileUrl, filenameHint) {
  const bucket = initGridFs();
  const response = await axios.get(fileUrl, { responseType: "stream" });
  const uploadStream = bucket.openUploadStream(filenameHint || `protein-${Date.now()}.cif`);

  await new Promise((resolve, reject) => {
    response.data.pipe(uploadStream).on("finish", resolve).on("error", reject);
  });

  return uploadStream.id.toString();
}

export function getProteinDownloadStream(fileId) {
  const bucket = initGridFs();
  return bucket.openDownloadStream(new ObjectId(fileId));
}
