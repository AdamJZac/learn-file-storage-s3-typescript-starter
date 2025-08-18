import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { arrayBuffer } from "stream/consumers";
import { config } from "process";
import { join } from "path";
import path from "path";
import { bundlerModuleNameResolver } from "typescript";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const thumbnail = formData.get("thumbnail");

  if (!(thumbnail instanceof File)) {
    throw new BadRequestError("Thumbnail is not a file");
  }
  if (thumbnail.type !== "image/jpeg" && thumbnail.type !== "image/png") {
    throw new BadRequestError("Invalid file type");
  }

  const MAX_UPLOAD_SIZE = 10 << 20;

  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail is too large");
  }

  let ab = await thumbnail.arrayBuffer();

  let video = getVideo(cfg.db, videoId);
  if (userID !== video?.userID) {
    throw new UserForbiddenError("Video unavailable to this user");
  }

  let tn: Thumbnail = {
    data: ab,
    mediaType: "image/png"
  }

  let ba = Buffer.from(ab);

  let assetPath = path.join(cfg.assetsRoot,`${videoId}.${thumbnail.type}`);

  await Bun.write(assetPath, ba);

  video.thumbnailURL = `http://localhost:${cfg.port}/${assetPath}`;
  console.log(video.thumbnailURL);

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
