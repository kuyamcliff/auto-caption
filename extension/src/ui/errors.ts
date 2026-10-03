// Every error the user can see goes through here: plain language first. Raw
// technical output (process output, stack traces) only goes to the logs; the
// panel shows a short reference the logs can be searched for.

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

const FRESH_COPY = "Copy a fresh AutoCaption Engine folder from the download, then choose it again.";

const MAP: Record<string, Omit<FriendlyError, "code" | "detail">> = {
  ENGINE_MISSING: { title: "Engine not found", causes: ["The AutoCaption Engine folder was moved, renamed or deleted."], actions: ["locate"] },
  ENGINE_UNSET: { title: "Choose the engine folder", causes: ["AutoCaption needs its engine folder from the download."], actions: ["locate"] },
  ENGINE_SPAWN: { title: "The engine could not start", causes: ["Security software blocked AutoCaption Engine.exe.", "The engine folder is incomplete."], actions: ["verify", "retry", "details"] },
  ENGINE_EXIT: { title: "The engine could not start", causes: ["The engine folder is incomplete or damaged.", "Security software stopped it."], actions: ["verify", "retry", "details"] },
  ENGINE_TIMEOUT: { title: "The engine is taking too long to start", causes: ["The computer is busy, or security software is scanning the engine folder."], actions: ["retry", "verify", "details"] },
  ENGINE_START: { title: "The engine could not start", causes: ["The engine folder is incomplete or damaged."], actions: ["verify", "retry", "details"] },
  ENGINE_UNREACHABLE: { title: "Lost connection to the engine", causes: ["The engine stopped or was closed by another program."], actions: ["retry", "details"] },
  ENGINE_DAMAGED: { title: "Some engine files are damaged or missing", causes: ["The download was incomplete or files were changed.", FRESH_COPY], actions: ["verify", "locate", "details"] },
  INCOMPATIBLE: { title: "This engine does not match the panel version", causes: ["Use the engine folder from the same AutoCaption download as the panel."], actions: ["locate", "details"] },
  ENGINE_START_FAILED: { title: "Transcription could not start", causes: ["The engine folder is incomplete.", "Graphics acceleration could not start."], actions: ["retry", "cpu", "details"] },
  ENGINE_ERROR: { title: "Transcription stopped unexpectedly", causes: ["The audio may be unusual or damaged.", "The graphics driver may have reset."], actions: ["retry", "cpu", "details"] },
  WORKER_CRASHED: { title: "Transcription stopped unexpectedly", causes: ["The computer may have run out of memory.", "Try Fast quality, or use the processor instead of the graphics card."], actions: ["retry", "cpu", "details"] },
  OUT_OF_MEMORY: { title: "Not enough memory", causes: ["Close other applications.", "Use Fast quality.", "Transcribe a shorter section."], actions: ["retry", "details"] },
  MODEL_MISSING: { title: "That quality level is not available", causes: ["The engine folder is incomplete. " + FRESH_COPY], actions: ["verify", "details"] },
  LANGUAGE_UNCERTAIN: { title: "Could not confidently detect the language", causes: ["Choose a language manually, then try again."], actions: ["language", "details"] },
  SILENT_AUDIO: { title: "This layer is silent", causes: ["The audio is muted, empty or very quiet at this point.", "Select a layer with audible speech."], actions: ["select"] },
  AUDIO_TOO_SHORT: { title: "The audio is too short", causes: ["Select a layer with at least a moment of speech."], actions: ["select"] },
  NO_SPEECH: { title: "No speech found", causes: ["The selected audio contains music or silence only."], actions: ["select"] },
  DECODE_FAILED: { title: "The audio could not be read", causes: ["The file format is not supported or the file is damaged."], actions: ["retry", "details"] },
  FFMPEG_MISSING: { title: "The audio decoder is missing", causes: ["The engine folder is incomplete. " + FRESH_COPY], actions: ["verify"] },
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
  SELFTEST_CRASH: { title: "The engine check could not finish", causes: ["The engine folder is incomplete, or security software blocked it."], actions: ["verify", "details"] },
  SELFTEST_FAILED: { title: "The engine check could not run", causes: ["The engine folder is incomplete, or security software blocked it."], actions: ["verify", "details"] },
};

/** Only short, neutral details reach the screen ("Reference 1a2b3c4d"). */
function safeDetail(detail?: string): string | undefined {
  if (!detail) return undefined;
  const ref = /Reference [0-9a-f]{8}/.exec(detail);
  return ref ? ref[0] : undefined;
}

export function friendlyError(e: RawError): FriendlyError {
  const m = MAP[e.code];
  const ref = safeDetail(e.detail);
  const detail = [m ? e.message : "", ref, "The log has the full details."].filter(Boolean).join("\n");
  if (m) return { code: e.code, ...m, detail };
  return { code: e.code, title: e.message || "Something went wrong", causes: e.hint ?? [], actions: ["retry", "details"], detail };
}
