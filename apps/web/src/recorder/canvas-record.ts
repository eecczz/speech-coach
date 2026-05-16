// Records the avatar canvas + mic audio into a single webm blob.
// IMPORTANT: the raw camera MediaStreamTrack must NEVER be added to this recorder.
// Only the canvas video track (already showing the avatar) + the mic audio track.

export interface AvatarRecording {
  blob: Blob;
  url: string;
  durationMs: number;
}

export class AvatarRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private stoppedResolve: ((rec: AvatarRecording) => void) | null = null;

  start(canvas: HTMLCanvasElement, micStream: MediaStream): void {
    const canvasStream = canvas.captureStream(30);
    const audioTrack = micStream.getAudioTracks()[0];
    if (audioTrack) canvasStream.addTrack(audioTrack);

    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';

    this.chunks = [];
    this.recorder = new MediaRecorder(canvasStream, { mimeType: mime });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: mime });
      const url = URL.createObjectURL(blob);
      const rec: AvatarRecording = {
        blob,
        url,
        durationMs: performance.now() - this.startedAt,
      };
      this.stoppedResolve?.(rec);
    };
    this.startedAt = performance.now();
    this.recorder.start(1000);
  }

  stop(): Promise<AvatarRecording> {
    return new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === 'inactive') {
        resolve({ blob: new Blob(), url: '', durationMs: 0 });
        return;
      }
      this.stoppedResolve = resolve;
      this.recorder.stop();
    });
  }
}
