// Every error the user can see goes through here: plain language first,
// technical detail kept for "View technical details" and the logs.

export type ErrorAction = "verify" | "retry" | "locate" | "start" | "language" | "select" | "details" | "cpu";

export interface FriendlyError {
  code: string;
  title: string;
  causes: string[];
  actions: ErrorAction[];
  detail?: string;
}

interface RawError {
  code: string;
  message: string;
  detail?: string;
  hint?: string[];
}

const MAP: Record<string, Omit<FriendlyError, "code" | "detail">> = {
  BACKEND_MISSING: { title: "Backend not found", causes: ["The backend folder was moved, renamed or deleted."], actions: ["locate"] },
  BACKEND_UNSET: { title: "Choose the backend folder", causes: ["AutoCaption needs its local caption engine."], actions: ["locate"] },
  BACKEND_SPAWN: { title: "The caption engine could not start", causes: ["Security software blocked AutoCaptionBackend.exe.", "The backend folder is incomplete."], actions: ["verify", "retry", "details"] },
  BACKEND_EXIT: { title: "The caption engine could not start", causes: ["The backend is incomplete.", "A model file is missing.", "A required system component is missing."], actions: ["verify", "retry", "details"] },
  BACKEND_TIMEOUT: { title: "The caption engine is taking too long to start", causes: ["The computer is busy, or antivirus software is scanning the backend."], actions: ["retry", "verify", "details"] },
  BACKEND_START: { title: "The caption engine could not start", causes: ["The backend is incomplete.", "A model file is missing."], actions: ["verify", "retry", "details"] },
  BACKEND_UNREACHABLE: { title: "Lost connection to the caption engine", causes: ["The engine stopped or was closed by another program."], actions: ["retry", "details"] },
  BACKEND_DAMAGED: { title: "Some backend files are damaged or missing", causes: ["The download was incomplete or files were changed.", "Replace the backend folder with a fresh copy from the download."], actions: ["verify", "locate", "details"] },
  INCOMPATIBLE: { title: "This backend does not match the extension version", causes: ["Use the backend folder from the same AutoCaption download as the extension."], actions: ["locate", "details"] },
  ENGINE_START_FAILED: { title: "The transcription engine could not start", causes: ["The backend is incomplete.", "A model file is missing.", "The GPU runtime is unavailable."], actions: ["verify", "retry", "details"] },
  ENGINE_ERROR: { title: "Transcription stopped unexpectedly", causes: ["The audio may be unusual or damaged.", "The GPU driver may have reset."], actions: ["retry", "cpu", "details"] },
  WORKER_CRASHED: { title: "The transcription engine stopped unexpectedly", causes: ["The computer may have run out of memory.", "Try the Base model or the CPU device."], actions: ["retry", "cpu", "details"] },
  OUT_OF_MEMORY: { title: "Not enough memory", causes: ["Close other applications.", "Use the Base model.", "Transcribe a shorter section."], actions: ["retry", "details"] },
  MODEL_MISSING: { title: "That model is not installed", causes: ["The backend folder is incomplete. Replace it with a fresh copy."], actions: ["verify", "details"] },
  LANGUAGE_UNCERTAIN: { title: "Could not confidently detect the language", causes: ["Choose a language manually, then try again."], actions: ["language", "details"] },
  SILENT_AUDIO: { title: "This layer is silent", causes: ["The audio is muted, empty or very quiet at this point.", "Select a layer with audible speech."], actions: ["select"] },
  AUDIO_TOO_SHORT: { title: "The audio is too short", causes: ["Select a layer with at least a moment of speech."], actions: ["select"] },
  NO_SPEECH: { title: "No speech found", causes: ["The selected audio contains music or silence only."], actions: ["select"] },
  DECODE_FAILED: { title: "The audio could not be read", causes: ["The file format is not supported or the file is damaged."], actions: ["retry", "details"] },
  FFMPEG_MISSING: { title: "The audio decoder is missing", causes: ["The backend folder is incomplete. Replace it with a fresh copy."], actions: ["verify"] },
  AUDIO_NOT_FOUND: { title: "The rendered audio could not be found", causes: ["Temporary files were removed while transcribing."], actions: ["retry"] },
  UNSUPPORTED_MEDIA: { title: "Unsupported media type", causes: ["Convert the media to WAV, MP3, MP4 or MOV."], actions: ["details"] },
  BUSY: { title: "Transcription in progress", causes: ["Wait for the current transcription to finish, or cancel it."], actions: [] },
  DISK_FULL: { title: "Not enough temporary disk space", causes: ["Free some space on your system drive, then try again."], actions: ["retry"] },
  RENDER_BUSY: { title: "After Effects is rendering", causes: ["Wait for the render queue to finish, then try again."], actions: ["retry"] },
  RENDER_FAILED: { title: "After Effects could not render the layer’s audio", causes: ["The footage may be offline or missing.", "The render queue may be busy."], actions: ["retry", "details"] },
  RENDER_EMPTY: { title: "After Effects did not produce audio", causes: ["The layer may have no audible audio in its time range."], actions: ["select", "details"] },
  RANGE_EMPTY: { title: "The layer is outside the composition", causes: ["Move or trim the layer so part of it lies inside the composition’s duration."], actions: ["select"] },
  LAYER_GONE: { title: "The selected layer no longer exists", causes: ["Select the layer again."], actions: ["select"] },
  COMP_GONE: { title: "The composition no longer exists", causes: ["Open the composition and select the layer again."], actions: ["select"] },
  TEMP_UNWRITABLE: { title: "Temporary files cannot be written", causes: ["Check that your TEMP folder exists and is writable."], actions: ["details"] },
  HOST_SCRIPT: { title: "After Effects did not respond", causes: ["Close any open dialogs in After Effects and try again."], actions: ["retry", "details"] },
  HOST_ERROR: { title: "After Effects reported an error", causes: ["Close any open dialogs in After Effects and try again."], actions: ["retry", "details"] },
  SELFTEST_CRASH: { title: "The backend self-test could not finish", causes: ["The backend is incomplete or blocked by security software."], actions: ["verify", "details"] },
  SELFTEST_FAILED: { title: "The backend self-test could not run", causes: ["The backend is incomplete or blocked by security software."], actions: ["verify", "details"] },
};

export function friendlyError(e: RawError): FriendlyError {
  const m = MAP[e.code];
  const detail = [e.code, e.message, e.detail].filter(Boolean).join("\n");
  if (m) return { code: e.code, ...m, detail };
  return { code: e.code, title: e.message || "Something went wrong", causes: e.hint ?? [], actions: ["retry", "details"], detail };
}
