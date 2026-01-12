import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from './lib/supabase';
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { generateAudioPath, generateVideoPath, SUPABASE_STORAGE_BUCKETS } from './utils/upload';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Supabase client
const supabase = createClient();

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Example endpoint using Supabase
app.get('/api/test', async (req: Request, res: Response) => {
  try {
    // Example: Test Supabase connection
    // Replace 'your_table_name' with an actual table from your Supabase database
    const { data, error } = await supabase
      .from('your_table_name')
      .select('*')
      .limit(1);
    
    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ 
        error: 'Database connection error', 
        details: error.message,
        note: 'Make sure you have created a table in your Supabase database'
      });
    }
    
    res.json({ 
      message: 'Supabase connection successful',
      data 
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post("/download", async (req, res) => {
  const { video_url: videoUrl, video_id: videoId } = req.body;

  if (!videoUrl || !videoId) {
    return res.status(400).json({ error: "Missing videoUrl or videoId", data: null, success: false });
  }

  const outputFile = path.join(TMP_DIR, generateVideoPath(videoUrl));

  const cmd = `
    yt-dlp -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${outputFile}" "${videoUrl}"
  `;

  exec(cmd, async (error) => {
    if (error) {
      return res.status(500).json({ error: error.message, data: null, success: false });
    }

    const stream = fs.createReadStream(outputFile);
    const videoPath = "videos/" + {videoId} + ".mp4";

    const { error: uploadError } = await supabase.storage
      .from(SUPABASE_STORAGE_BUCKETS.TMP_VIDEOS)
      .upload(videoPath, stream, {
        contentType: "video/mp4",
        upsert: true,
      });

    fs.unlinkSync(outputFile);

    if (uploadError) {
      return res.status(500).json({ error: uploadError.message, data: null, success: false });
    }

    return res.json({ success: true, data: { video_path: videoPath }, message: "Video downloaded and uploaded successfully" });
  });
});

const TMP_DIR = "/tmp";
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

/**
 * POST /extract-audio
 * {
 *   "videoUrl": "<Supabase public URL or any video URL>",
 *   "uploadPath": "audios/audio1.mp3" // optional
 * }
 */
app.post("/extract-audio", async (req, res) => {
  const { media_url: videoUrl, upload_path: uploadPath } = req.body;
  if (!videoUrl) return res.status(400).json({ error: "Missing videoUrl", data: null, success: false });

  const videoPath = path.join(TMP_DIR, generateVideoPath(videoUrl));
  const audioPath = path.join(TMP_DIR, generateAudioPath(videoUrl));

  try {
    // 1️⃣ Download the video to TMP_DIR
    const response = await fetch(videoUrl);
    if (!response.ok) return res.status(500).json({ error: "Failed to fetch video", data: null, success: false });

    const videoStream = fs.createWriteStream(videoPath);
    await new Promise((resolve, reject) => {
      response?.body?.pipe(videoStream);
      response.body?.on!("error", reject);
      videoStream.on("finish", () => resolve(undefined));
    });

    // 2️⃣ Extract audio using ffmpeg
    await new Promise((resolve, reject) => {
      const cmd = `ffmpeg -y -i "${videoPath}" -vn -acodec libmp3lame -q:a 2 "${audioPath}"`;
      exec(cmd, (err, stdout, stderr) => {
        if (err) return res.status(500).json({ error: err.message, data: null, success: false });
        resolve(undefined);
      });
    });

    // 3️⃣ If uploadPath provided, upload to Supabase
    if (uploadPath) {
      const stream = fs.createReadStream(audioPath);
      const { error: uploadError } = await supabase.storage
        .from("audios")
        .upload(uploadPath, stream, {
          contentType: "audio/mpeg",
          upsert: true,
        });
      if (uploadError) return res.status(500).json({ error: uploadError.message, data: null, success: false });

      // Cleanup
      fs.unlinkSync(videoPath);
      fs.unlinkSync(audioPath);

      return res.json({
        data: { audio_path: uploadPath, video_path: videoPath, url: `${process.env.SUPABASE_URL}/storage/v1/object/public/audios/${uploadPath}` },
        success: true,
        message: "Audio extracted and uploaded",
      });
    }

    // 4️⃣ Otherwise, stream audio back to client
    res.setHeader("Content-Type", "audio/mpeg");
    const audioStream = fs.createReadStream(audioPath);
    audioStream.pipe(res);

    audioStream.on("end", () => {
      fs.unlinkSync(videoPath);
      fs.unlinkSync(audioPath);
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
