/**
 * Every kit specimen, drawn through the kit it is given: the app's own copy
 * on the page side, /plugin-sdk/plugin-ui.js in the frame. The frame bundle
 * (ui-kit-sheet.js) holds this file and the sections, never a core module.
 */
import type { ComponentType } from 'react';
import { FoundationSection, type SectionProps } from './sections/Foundation';
import { ControlsSection } from './sections/Controls';
import { PanelsSection } from './sections/Panels';
import { DataSection } from './sections/Data';

export type KitSheetProps = SectionProps;

const SECTIONS: Array<ComponentType<SectionProps>> = [FoundationSection, ControlsSection, PanelsSection, DataSection];

export function Sheet({ kit, side }: KitSheetProps) {
  return (
    <div data-kit-side={side}>
      {SECTIONS.map((Section, i) => (
        <Section key={i} kit={kit} side={side} />
      ))}
    </div>
  );
}
