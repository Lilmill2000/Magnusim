// The Assistant's page API inside the Part (published as services.apis.assistant by the
// Assistant module; null or absent without it). One writer: ASSISTANT.
// For now only the camera gate the other areas ask before an automatic camera move.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The automatic camera moves that ask first (each passes `auto: true` to the viewport, so
 * ViewportHandle.userCameraMoves does not count it):
 *   'sketch-entry'    sketch mode turns the view to look straight at the sketch's plane;
 *   'sketch-reframe'  a reopened sketch frames again once the later features are rolled back;
 *   'extrude-iso'     a new Extrude seen along its direction turns the view to Isometric.
 */
export type AutoCameraReason = 'sketch-entry' | 'sketch-reframe' | 'extrude-iso';

export interface AssistantPageApi {
  /**
   * Whether an automatic camera move for this edit session may run now. True for every session
   * the Assistant does not own, so the person's own sketches and extrudes turn the view as they
   * always did. For the Assistant's own sessions it says no once the person has moved the camera
   * during the turn, while the window is hidden, or when the pace is fast.
   */
  autoCamera(reason: AutoCameraReason, sessionId: string | null): boolean;
}
