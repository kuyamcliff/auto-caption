import { Icon } from "../icons";

export function Help() {
  return (
    <div class="scroll">
      <div class="page help" style={{ maxWidth: 560 }}>
        <div class="card card-pad stack-lg">
          <div>
            <h3>How it works</h3>
            <ol>
              <li><b>Select a layer</b> in your composition: audio, video, or a precomp.</li>
              <li><b>Transcribe.</b> AutoCaption renders that layer’s audio exactly as the composition plays it, then transcribes it on this computer.</li>
              <li><b>Edit</b> any caption by double‑clicking it. Fix words, split, merge or delete.</li>
              <li><b>Choose words per line.</b> Captions regroup instantly without transcribing again.</li>
              <li><b>Choose an animation</b> and press play in the preview.</li>
              <li><b>Create Text Layers.</b> One text layer per caption, placed on the exact frames.</li>
            </ol>
          </div>
          <div>
            <h3>Why alignment takes time</h3>
            <p>Whisper writes down what was said, but its timestamps are rough. AutoCaption then listens again with a second model that matches every word to the exact moment it is spoken. That second pass is what makes word animations land on the beat, and it takes a few extra seconds.</p>
          </div>
          <div>
            <h3>Timing labels</h3>
            <p><span class="badge ok">Aligned</span> found in the audio · <span class="badge inferred">Inferred</span> estimated from nearby words (for words you typed, or words the aligner couldn’t hear) · <span class="badge warn">Estimated</span> no alignment model for this language · <span class="badge accent">Manual</span> set by you.</p>
          </div>
          <div>
            <h3>Shortcuts</h3>
            <p>Space play/pause preview · ↑/↓ move between captions · Enter edit · Ctrl+Enter split at cursor · Ctrl+Z / Ctrl+Shift+Z undo/redo · Delete removes a caption.</p>
          </div>
          <div class="privacy">{Icon.shield()}<span>Everything runs locally. Your audio stays on this computer.</span></div>
        </div>
      </div>
    </div>
  );
}
