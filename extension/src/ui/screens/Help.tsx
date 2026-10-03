import { Icon } from "../icons";
import { Credit } from "./Onboarding";

export function Help() {
  return (
    <div class="scroll">
      <div class="page help" style={{ maxWidth: 560 }}>
        <div class="card card-pad stack-lg">
          <div>
            <h3>How it works</h3>
            <ol>
              <li><b>Select a layer</b> in your composition: audio, video or a precomp.</li>
              <li><b>Transcribe.</b> AutoCaption renders that layer’s audio exactly as the composition plays it, then transcribes it on this computer.</li>
              <li><b>Edit</b> any caption by double‑clicking it. Fix words, split, merge or delete.</li>
              <li><b>Choose words per line.</b> Captions regroup instantly without transcribing again.</li>
              <li><b>Choose an animation</b> and press play in the preview.</li>
              <li><b>Create Text Layers.</b> One text layer per caption, placed on the exact frames.</li>
            </ol>
          </div>
          <div>
            <h3>Fast or Accurate?</h3>
            <p>Fast gives the quickest results and suits clear speech. Accurate takes longer and copes better with accents, noise and music.</p>
          </div>
          <div>
            <h3>Why word timing takes a moment</h3>
            <p>After writing down what was said, AutoCaption listens again and finds the exact moment each word starts and ends. That second pass is what makes word animations land on the beat, and it takes a few extra seconds.</p>
          </div>
          <div>
            <h3>Timing labels</h3>
            <p><span class="badge ok">Precise</span> found in the audio. <span class="badge inferred">Inferred</span> worked out from nearby words (words you typed, or words too quiet to hear). <span class="badge warn">Estimated</span> precise timing is not available for this language. <span class="badge accent">Manual</span> set by you.</p>
          </div>
          <div>
            <h3>Shortcuts</h3>
            <p>Space plays or pauses the preview. Up and Down move between captions. Enter edits. Ctrl+Enter splits at the cursor. Ctrl+Z undoes, Ctrl+Shift+Z redoes. Delete removes a caption.</p>
          </div>
          <div class="privacy">{Icon.shield()}<span>Everything runs on this computer. Your audio never leaves it.</span></div>
          <Credit />
        </div>
      </div>
    </div>
  );
}
