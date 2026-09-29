/**
 * The stub analysis's own study and run settings (gate:h10-plugin-owned-ui):
 * the core draws the panels' chrome, this plugin draws what is inside.
 */
import { useEffect, useState } from 'react';
import type { RunSettingsProps, StudySettingsProps } from '../../../../../../src/plugin-api';
import type { PluginHost } from '../../../../../../src/plugins/loader';

function DiffusivityRow({ value, onCommit }: { value: unknown; onCommit: (n: number) => void }) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => setText(value == null ? '' : String(value)), [value]);
  return (
    <div className="mat-row">
      <span className="mat-k">Diffusivity</span>
      <span className="mat-v bc-value-row">
        <input
          className="bc-input"
          aria-label="Diffusivity"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const n = Number(text);
            if (Number.isFinite(n) && n !== Number(value)) onCommit(n);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <span className="bc-unit-label">m²/s</span>
      </span>
    </div>
  );
}

function StudySettings({ study, save }: StudySettingsProps) {
  const record = (study.record || {}) as Record<string, unknown>;
  return (
    <div data-stub-study-settings="1">
      <DiffusivityRow value={record.diffusivity} onCommit={(n) => void save({ diffusivity: n })} />
      <p className="mat-assign-hint">Steady scalar diffusion, solved with laplacianFoam.</p>
    </div>
  );
}

function RunSettings({ run }: RunSettingsProps) {
  return (
    <div data-stub-run-settings="1">
      <div className="mat-row">
        <span className="mat-k">Iterations</span>
        <span className="mat-v" data-stub-iterations="1">
          {String(run.settings.end_time ?? '')}
        </span>
      </div>
    </div>
  );
}

export function register(host: PluginHost): void {
  host.pluginUi.registerStudySettings('stub-analysis.study', StudySettings);
  host.pluginUi.registerRunSettings('stub-analysis.run', RunSettings);
}
