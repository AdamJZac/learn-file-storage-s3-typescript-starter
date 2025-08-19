import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import { readableStreamToText, S3Client, type BunRequest } from "bun";
import { getBearerToken, validateJWT } from "../auth";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getVideo, updateVideo, type Video } from "../db/videos";
import path from "path";
import { randomBytes } from "crypto";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video", videoId, "by user", userID);

  const formData = await req.formData();
  const data = formData.get("video");

  if (!(data instanceof File)) {
    throw new BadRequestError("Upload is not a file");
  }

  const MAX_UPLOAD_SIZE = 1 << 30;
  
  if (data.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Upload is too large");
  }

  let video = getVideo(cfg.db, videoId);

  if (userID !== video?.userID) {
    throw new UserForbiddenError("Invalid user id for this action");
  }

  if (data.type !== "video/mp4") {
    throw new BadRequestError("Invalid file type");
  }

  let assetPath = path.join(cfg.assetsRoot,`${videoId}.${data.type.split("/")[1]}`);
  
  await Bun.write(assetPath, data);
  let processedAssetPath = await processVideoForFastStart(assetPath);
  await Bun.file(assetPath).delete();
  let bunFile = Bun.file(processedAssetPath, {type: "video/mp4"});
  let ar = await getVideoAspectRatio(processedAssetPath);

  let s3Key = `${ar}${randomBytes(32).toString("hex")}-processed.mp4`;
  let s3 = cfg.s3Client;
  await s3.write(s3Key, bunFile, {type: "video/mp4"});

  //let vidUrl = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${s3Key}`;

  video.videoURL = s3Key;
  updateVideo(cfg.db, video);

  await bunFile.delete();
  return respondWithJSON(200, null);
}

export async function getVideoAspectRatio(filePath: string) {
  const sp = Bun.spawn({
    cmd: ["ffprobe","-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","json",filePath],
     stdout: "pipe",
     stderr: "pipe"
    });

    let code = await sp.exited

    if (code !== 0) {
      throw new Error(`Error reading file with ffprobe ${code}`);
    }
    
    let text = await new Response(sp.stdout).json();
    let height = text.streams[0].height;
    let width = text.streams[0].width;
    
    let aspectRatio = getAspectCategory(width, height);

    return aspectRatio;
}

function getAspectCategory(width: number, height: number): string {
  const ratio = width / height;
  const tolerance = 0.01;
  
  const aspectRatios: Record<string, number> = {
    "16:9": 16 / 9,
    "9:16": 9 / 16,
    "4:3": 4 / 3,
    "3:4": 3 / 4,
    "1:1": 1,
  };

  for (const [label, value] of Object.entries(aspectRatios)) {
    if (Math.abs(ratio - value) < tolerance) {
      if (label === "16:9" || label === "4:3") return "landscape/";
      if (label === "9:16" || label === "3:4") return "portrait/";
    }
  }

  return "other";
}

async function processVideoForFastStart(inputFilePath: string) {
  let outputPath = `${inputFilePath.slice(0,inputFilePath.length-4)}-processed.mp4`;
  const sp = Bun.spawn({
    cmd: ["ffmpeg","-i",inputFilePath,"-movflags","faststart","-map_metadata","0","-codec","copy","-f","mp4", outputPath],
     stdout: "pipe",
     stderr: "pipe"
    });

    let code = await sp.exited;

    if (code !== 0) {
      throw new Error(`Error reading file with ffmpeg ${code}`);
    }

    return outputPath;
}

function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number) {
  const s3 = cfg.s3Client;
  const file = s3.file(key);
  return file.presign({expiresIn: expireTime});
}

export function dbVideoToSignedVideo(cfg: ApiConfig, video: Video) {
  video.videoURL = generatePresignedURL(cfg, (video.videoURL as string), 3600);
  return video;
}

