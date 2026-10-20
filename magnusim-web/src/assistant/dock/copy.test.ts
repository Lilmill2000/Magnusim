// The dock's words, pinned (phase 4 spec 2, 4.5, 10.1).
import { describe, expect, it } from 'vitest';
import * as copy from './copy';

describe('the dock copy', () => {
  it('header, conversations and the person\'s message', () => {
    expect([copy.DOCK_TITLE, copy.NEW_CONVERSATION, copy.ASSISTANT_SETTINGS, copy.CLOSE_DOCK]).toEqual(['Assistant', 'New conversation', 'Assistant settings', 'Close the Assistant']);
    expect([copy.GROUP_HERE, copy.GROUP_HOME, copy.GROUP_OTHER_PROJECTS]).toEqual(['Here', 'Home', 'Other projects']);
    expect(copy.CONVERSATIONS_EMPTY).toBe('No conversations yet. Magnusim keeps them while it runs; a restart clears them.');
    expect(copy.forgetLabel('Box')).toBe('Forget Box');
    expect([copy.FORGET, copy.FORGET_TITLE, copy.FORGET_KEEP]).toEqual(['Forget', 'Forget this conversation?', 'Keep']);
    expect(copy.FORGET_COPY).toBe("The Assistant forgets its messages; this can't be undone. What it changed in your projects stays.");
    expect(copy.FORGET_BUSY).toBe('A request is running in this conversation. Stop it first.');
    expect(copy.conversationMeta('Local server', '09:41')).toBe('Local server · 09:41');
    expect(copy.readOnlyConversation('Wing')).toBe('This conversation is about project "Wing". Open that project to continue it, or start a new conversation here.');
    expect(copy.OPEN_PROJECT).toBe('Open project');
    expect(copy.FROM_PROGRAM).toBe('From the command line or another program');
  });

  it('tool steps', () => {
    expect((['read', 'edit', 'compute', 'destructive'] as const).map(copy.riskBadge)).toEqual(['Reads', 'Changes', 'Runs a computation', "Can't be undone"]);
    expect(copy.WHAT_IT_SENT).toBe('What it sent');
    expect([copy.seconds(812), copy.seconds(40), copy.seconds(12_400), copy.seconds(125_000)]).toEqual(['0.8 s', '0.0 s', '12 s', '2 min 5 s']);
    expect(copy.resultOk('Extruded', 812)).toBe('✓ Extruded · 0.8 s');
    expect(copy.resultFailed('No such edge')).toBe('✗ No such edge');
    expect(copy.howToFix('Pick an edge.')).toBe('How to fix: Pick an edge.');
    expect(copy.waitsFor('CAD', 'Paused by the person')).toBe('Waits for you in CAD: Paused by the person');
    expect(copy.pictureAlt(1, 3, 'Extrude')).toBe('Picture 1 of 3 from Extrude');
    expect(copy.PICTURE_GONE).toBe('Picture no longer kept');
  });

  it("a coding agent's events", () => {
    expect(copy.agentLine('Helper', '1.2', 'off')).toBe('Helper 1.2 · its own tools are off');
    expect(copy.agentLine('Helper', null, 'on')).toBe('Helper · its own tools are on: it can run commands and change files on this PC by its own rules.');
    expect([copy.PLAN_HEADING, copy.OWN_TOOLS_HEADING]).toEqual(['Its plan', 'Its own tools']);
    expect(copy.agentToolLine('Read file', 'read')).toBe('Read file · read');
    expect([
      copy.agentPermissionLine('X', 'auto_allowed', 'magnusim'),
      copy.agentPermissionLine('X', 'allowed', 'user'),
      copy.agentPermissionLine('X', 'declined', 'user'),
      copy.agentPermissionLine('X', 'declined', 'magnusim'),
      copy.agentPermissionLine('X', 'declined', 'timeout'),
      copy.agentPermissionLine('X', 'cancelled', 'stop'),
    ]).toEqual([
      'Auto-allowed: X. Magnusim asks you itself when one of its tools needs it.',
      'You allowed: X',
      'You declined: X',
      'Declined: X',
      'Not answered in time, so declined: X',
      'Withdrawn: X',
    ]);
    expect([copy.agentModeLine('Ask'), copy.agentModelLine('Big')]).toEqual(['Mode: Ask', 'Model: Big']);
  });

  it('review rounds, fallback, the footer and the counters', () => {
    expect(copy.reviewDivider(1, 3)).toBe('Checking its work · round 1 of 3');
    expect(copy.reviewFooter(1, 3)).toBe('Checking its work (round 1 of 3)…');
    expect(copy.fallbackLine('model-a', 'model-b')).toBe('Answered by model-b after model-a declined the request.');
    expect([copy.FOOTER_STARTING, copy.FOOTER_ANSWER_BELOW, copy.FOOTER_THINKING, copy.FOOTER_STOPPING, copy.FOOTER_STILL_STOPPING]).toEqual([
      'Starting…',
      'Waiting for your answer below.',
      'Thinking…',
      'Stopping…',
      'Still stopping…',
    ]);
    expect(copy.agentWorking('Helper')).toBe('Helper is working…');
    expect([copy.working('Extrude'), copy.working('Extrude', 'Meshing')]).toEqual(['Working: Extrude', 'Working: Extrude · Meshing']);
    expect(copy.stepCounters(3, 120, 179_999, 60)).toBe('3 of 120 steps · 2 of 60 min');
    expect(copy.agentCounters(2, 24, 17, 400, 60_000, 60)).toBe('2 of 24 changes · 17 of 400 tool calls · 1 of 60 min');
    expect(copy.meterUsd(0.42, 8, false, 3.1, 15)).toBe('This request: $0.42 of $8.00 · Today: $3.10 of $15.00');
    expect(copy.meterUsd(0.42, 8, true, 3.1, 15)).toBe('This request: about $0.42 of $8.00 · Today: $3.10 of $15.00');
    expect(copy.METER_FREE).toBe('Local server · no cost');
    expect(copy.meterAgent('Helper')).toBe("Billed to your Helper account (Magnusim can't see the cost)");
  });

  it('the pill, dock states and turn ends', () => {
    expect(copy.pillRunning('Thinking…', '3 of 120 steps · 0 of 60 min')).toBe('Assistant · Thinking… · 3 of 120 steps · 0 of 60 min');
    expect(copy.pillQuestion('Reset the counter?')).toBe('Assistant asks: Reset the counter?');
    expect(copy.pillQuestion('Send project "A very long project title indeed" to the provider?')).toBe('Assistant asks: Send project "A very long project title…');
    expect((['done', 'stopped', 'capped', 'failed'] as const).map(copy.pillDone)).toEqual(['Assistant: done', 'Assistant: stopped', 'Assistant: reached a limit', "Assistant: didn't finish"]);
    expect([copy.STOP, copy.STOP_LABEL]).toEqual(['Stop', 'Stop the Assistant']);
    expect([copy.STATE_LOADING, copy.STATE_ERROR, copy.TRY_AGAIN, copy.OPEN_SETTINGS]).toEqual(['Loading the Assistant…', "Magnusim's server didn't answer.", 'Try again', 'Open Settings']);
    expect(copy.STATE_OFF).toBe('The Assistant is off. Choose a provider in Settings → Assistant.');
    expect((['done', 'stopped', 'capped', 'failed'] as const).map(copy.endLabel)).toEqual([null, 'Stopped', 'Limit reached', "Didn't finish"]);
    expect(copy.endBody('capped', null)).toBe('Send another message to carry on.');
    expect(copy.endBody('failed', 'The model declined this request.')).toBe('The model declined this request.');
    expect([copy.usageLine(4, 'usd', 0.42, null), copy.usageLine(1, 'free', 0, null), copy.usageLine(9, 'agent_account', 0, 'Helper')]).toEqual([
      '4 steps · $0.42',
      '1 step · no cost',
      '9 steps · billed to your Helper account',
    ]);
    expect(copy.RECORD_GONE).toBe("This request's record is gone: Magnusim keeps it while its conversation lives.");
    expect(copy.LOG_DROPPED).toBe("This request's details are no longer kept.");
    expect(copy.QUESTIONS_ELSEWHERE).toBe('Its questions show in the window that started it.');
    expect(copy.QUESTION_ELSEWHERE).toBe('Its question shows in the window that started it.');
  });

  it('questions in the transcript and the live region', () => {
    expect(copy.gateAsked('Reset?')).toBe('Asked: Reset?');
    expect([
      copy.gateClosedLine('allow', 'user', 'Reset', 'Keep', 'Reset?'),
      copy.gateClosedLine('deny', 'user', 'Reset', 'Keep', 'Reset?'),
      copy.gateClosedLine('deny', 'timeout', 'Reset', 'Keep', 'Reset?'),
      copy.gateClosedLine('deny', 'stop', 'Reset', 'Keep', 'Reset?'),
    ]).toEqual(['You chose “Reset”: Reset?', 'You chose “Keep”: Reset?', 'No answer in time, so “Keep”: Reset?', 'Withdrawn: Reset?']);
    expect(copy.LIVE_WORKING).toBe('The Assistant is working.');
    expect([copy.liveToolDone('Add'), copy.liveToolFailed('Add')]).toEqual(['Add: done', 'Add: failed']);
    expect(copy.liveWaiting('CAD')).toBe('The Assistant waits for you in CAD.');
    expect(copy.liveFinished('  ')).toBe('The Assistant finished.');
    expect(copy.liveEnded('Stopped', null)).toBe('Stopped.');
    expect([copy.liveStepsDone(1), copy.liveStepsDone(3)]).toEqual(['1 step done', '3 steps done']);
    expect([copy.LIVE_A_STEP, copy.LIVE_ITS_WORKSPACE]).toEqual(['A step', 'its workspace']);
  });

  it('names no vendor', () => {
    const words = Object.values(copy)
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
    expect(words).not.toMatch(/anthropic|openai|claude|gpt|gemini|cursor|codex|copilot/i);
  });
});
