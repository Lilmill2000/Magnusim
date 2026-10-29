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

  it('the menu, the transcript and the intros', () => {
    expect([copy.NEW_SHORT, copy.CONVERSATIONS_LABEL, copy.WORKING_DOT]).toEqual(['New', 'Conversations', 'working']);
    expect(copy.hhmm('2026-10-20T09:05:00')).toBe('09:05');
    expect(copy.hhmm('not a date')).toBe('');
    expect(copy.yourPictureAlt(1, 2)).toBe('Your picture 1 of 2');
    expect([copy.SHOW_EARLIER, copy.NEW_MESSAGES, copy.ELSEWHERE]).toEqual(['Show earlier requests', 'New messages ↓', 'Elsewhere']);
    expect([copy.PICTURE_VIEWER, copy.CLOSE_PICTURE, copy.PREVIOUS_PICTURE, copy.NEXT_PICTURE]).toEqual(['Picture viewer', 'Close the picture', 'Previous picture', 'Next picture']);
    expect(copy.INTRO_PROJECT).toBe('Tell the Assistant what to set up or run in this project (studies, materials, boundary conditions, meshes, runs), or ask about its results. Open a CAD Part to have it build or change one.');
    expect(copy.INTRO_HOME).toMatch(/^Ask about your projects, or tell the Assistant what to simulate: it can make a project/);
    expect(copy.introCad('Part 1')).toBe('Tell the Assistant what to model in Part 1. You can watch each step, pause or take over in the Part, and stop it here.');
    expect(copy.introWorkspace('Counter')).toBe('Tell the Assistant what to do in Counter.');
  });

  it('the provider picker and the composer', () => {
    expect([copy.PROVIDER, copy.providerDefault('A'), copy.providerAgent('Helper'), copy.notReady('No key'), copy.notReady('')]).toEqual([
      'Provider',
      'A · default',
      'Helper (coding agent)',
      'No key · not ready',
      'not ready',
    ]);
    expect([copy.billingTag('usd', ''), copy.billingTag('free', ''), copy.billingTag('agent_account', 'Helper')]).toEqual(['API key, $ limits apply', 'No cost', 'Billed to your Helper account']);
    expect(['agent_not_allowed', 'agent_missing', 'agent_allow_changed', 'agent_signed_out', 'mcp_unavailable', 'not_checked', 'other', null].map(copy.agentReason)).toEqual([
      'Off until you allow it in Settings → Assistant',
      'Not installed',
      'Its command changed: allow it again',
      'Not signed in',
      "Its tool connection isn't running",
      'Not looked for yet: open Settings → Assistant',
      null,
      null,
    ]);
    expect(copy.PROVIDER_LOCKED).toBe('A conversation keeps its provider. Start a new one to use another.');
    expect(copy.SET_UP_PROVIDERS).toBe('Set up providers in Settings → Assistant');
    expect([copy.MESSAGE_LABEL, copy.placeholderWorkspace('CAD'), copy.PLACEHOLDER_PROJECT, copy.PLACEHOLDER_HOME]).toEqual([
      'Message to the Assistant',
      'Tell the Assistant what to do in CAD…',
      'Ask about this project…',
      'Ask the Assistant…',
    ]);
    expect([copy.COMPOSER_HINT, copy.charCount(18_000), copy.SEND, copy.WORKING_ON_IT]).toEqual([
      'Enter sends · Shift+Enter for a new line',
      '18,000 of 20,000 characters',
      'Send',
      'The Assistant is working on your last message.',
    ]);
    expect(copy.providerNotReady('Cloud A', 'No key')).toBe('Cloud A: No key. Settings → Assistant can fix it.');
    expect(copy.tabBusy('CAD')).toBe('A request is already working in CAD. Wait for it, or stop it.');
    expect([copy.STOP_THAT_REQUEST, copy.CONVERSATION_FULL]).toEqual(['Stop that request', 'This conversation is full. Start a new one.']);
    expect([copy.ATTACH_LABEL, copy.ONLY_IMAGES, copy.AT_MOST_FOUR, copy.PICTURES_GO]).toEqual([
      'Attach pictures or files',
      'Only PNG, JPEG and WebP pictures can be attached.',
      'At most 4 pictures per message.',
      'Pictures go to the provider with your message.',
    ]);
    // What can be attached, with drawings while the dock offers them (drawings.ts) and without.
    expect([copy.dropPictures(true), copy.attachFilesOnly('Helper', true), copy.dropFiles(true), copy.onlyFiles(true)]).toEqual([
      'Drop pictures, geometry files or drawings to attach',
      "Attach geometry files or drawings (Helper doesn't take pictures)",
      'Drop geometry files or drawings to attach',
      'Only pictures, geometry files (STEP, IGES, BREP, STL, OBJ, PLY) and drawings (SVG, DXF) can be attached.',
    ]);
    expect([copy.dropPictures(false), copy.attachFilesOnly('Helper', false), copy.dropFiles(false), copy.onlyFiles(false)]).toEqual([
      'Drop pictures or geometry files to attach',
      "Attach geometry files (Helper doesn't take pictures)",
      'Drop geometry files to attach',
      'Only pictures and geometry files (STEP, IGES, BREP, STL, OBJ, PLY) can be attached.',
    ]);
    expect([
      copy.fileTooLarge('big.step'),
      copy.drawingTooLarge('poster.svg'),
      copy.AT_MOST_FOUR_FILES,
      copy.FILES_STAY,
      copy.DRAWINGS_STAY,
      copy.ATTACHED_FILES,
    ]).toEqual([
      'big.step is larger than 500 MB. Import it with + Add geometry.',
      'poster.svg is larger than 20 MB, the limit for a drawing.',
      'At most 4 files per message.',
      'Files stay on this PC. The Assistant gets their names and can import them into the project open here. A workspace tool may read one, and what it reports goes to the provider.',
      'Files stay on this PC. The Assistant gets their names. It can import geometry files into the project open here, and drawings in a workspace that imports them. A workspace tool may read one, and what it reports goes to the provider.',
      'Attached files',
    ]);
    expect([copy.uploadingLabel('a.stl'), copy.waitingForUpload('a.stl'), copy.uploadLost('a.stl')]).toEqual([
      'Uploading a.stl',
      'Waiting for a.stl to finish uploading…',
      "a.stl didn't reach Magnusim's server. Attach it again.",
    ]);
    expect([0, 1, 512, 1024, 12_345, 4.2 * 1024 * 1024, 37.6 * 1024 * 1024, 500 * 1024 * 1024].map(copy.fileSize)).toEqual(['0 bytes', '1 byte', '512 bytes', '1 KB', '12 KB', '4.2 MB', '38 MB', '500 MB']);
    expect(copy.fileChip('bracket.step', 4.2 * 1024 * 1024)).toBe('bracket.step · 4.2 MB');
    expect([copy.shrunkTo(2000, 92), copy.tooLargeAfterShrinking('a.jpg'), copy.pictureChip('a.png', 64, 48), copy.removePicture('a.png')]).toEqual([
      'Shrunk to 2000 × 92 px to fit',
      'a.jpg is larger than 1.5 MB even after shrinking it.',
      'a.png · 64 × 48',
      'Remove a.png',
    ]);
    // A coding agent that said it takes none; one that takes them gets them, and says where they go.
    expect(copy.noPictures('Helper')).toBe("Helper doesn't take pictures. Send the message without them.");
    expect(copy.picturesGoToAgent('Helper')).toBe('Pictures go to Helper with your message, and on to its own service.');
    expect([
      copy.CONTEXT_HOME,
      copy.contextProject('Wing'),
      copy.contextWorkspace('CAD', 'Wing'),
      copy.contextConnecting('CAD'),
      copy.waitingForTools('CAD'),
      copy.contextLate('CAD'),
      copy.contextNoTools('CAD', 'Wing'),
    ]).toEqual([
      'Home · no project',
      'Project: Wing',
      'CAD in Wing',
      'CAD · connecting…',
      'Waiting for CAD to offer its tools…',
      'CAD offers no tools now · the Assistant can read the project only',
      'CAD offers no tools · Project: Wing',
    ]);
  });

  it('tool steps', () => {
    expect((['read', 'edit', 'compute', 'destructive'] as const).map(copy.riskBadge)).toEqual(['Reads', 'Changes', 'Runs a computation', "Can't be undone"]);
    expect(copy.WHAT_IT_SENT).toBe('What it sent');
    expect([copy.seconds(812), copy.seconds(40), copy.seconds(12_400), copy.seconds(125_000)]).toEqual(['0.8 s', '0.0 s', '12 s', '2 min 5 s']);
    expect(copy.resultOk('Extruded', 812)).toBe('✓ Extruded · 0.8 s');
    expect(copy.resultFailed('No such edge')).toBe('✗ No such edge');
    expect(copy.howToFix('Pick an edge.')).toBe('How to fix: Pick an edge.');
    expect(copy.waitsFor('CAD', 'Paused by the person')).toBe('Waits for you in CAD: Paused by the person');
    // A core page tool on Home or in the workbench (core host tools spec 5.3): its own words.
    expect(copy.waitsFor('', 'Waiting for you to finish with the view')).toBe('Waiting for you to finish with the view');
    expect(copy.waitsFor('', '')).toBe('Waits for you');
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

  it('the question card', () => {
    expect([copy.ANSWER_HERE_ONLY, copy.PROJECT_DATA, copy.PRIVACY_SETTINGS, copy.ASKED_BY_APP]).toEqual(['Answer here only', 'Project data', 'Privacy settings', 'Asked by another app on this PC.']);
    expect(copy.askedOutside('Add 7')).toBe('Asked by a request started outside this window: "Add 7"');
    expect([copy.closesIn(0), copy.closesIn(9)]).toEqual(['Closes in under a minute', 'Closes in 9 min']);
    expect(copy.gateHelp("Don't", 'Allow')).toBe("Enter or Escape answers “Don't”. “Allow” takes a click, or Tab then Space.");
  });

  it('Undo these changes', () => {
    expect([copy.UNDO_CHANGES, copy.UNDO_WAIT, copy.UNDO_WHILE_OPEN]).toEqual(['Undo these changes', 'Wait for the running request to end.', 'Undo lasts while the Part stays open.']);
    expect(copy.undoTitle('CAD')).toBe("Undo the Assistant's changes of this request in CAD (one step)");
    expect(copy.undone('CAD')).toBe('Undone. Redo (Ctrl+Y) in CAD brings them back.');
    expect(copy.undoNotNewest('CAD')).toBe("Something changed after this request, so its changes can't be undone as one step here. Use Undo in CAD.");
    expect(copy.undoBusy('CAD')).toBe('CAD is busy; try again in a moment.');
    expect(copy.undoNoAnswer('CAD')).toBe("CAD didn't answer. Its own Undo still works.");
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

describe('the Updated line (phase 5, C2)', () => {
  it('names each kind a call changed, with its records, and leaves out how the window follows', () => {
    expect(copy.updatedLine(['bcs'], { bc: ['bc-7'] }, { 'bc-7': 'Inlet' })).toBe('Updated: Boundary conditions (Inlet)');
    expect(copy.updatedLine(['bcs', 'mesh'], { bc: ['a', 'b'], mesh: ['m'] }, { a: 'Inlet', b: 'Outlet' })).toBe('Updated: Boundary conditions (Inlet, Outlet); Mesh');
    expect(copy.updatedLine(['project', 'study', 'materials', 'bc_defaults', 'refinements', 'runs', 'geometry', 'plugin_studies'], {}, {})).toBe(
      'Updated: Project; Study; Materials; Boundary condition defaults; Mesh refinements; Runs; Geometry; Studies',
    );
    expect(copy.updatedLine(['active', 'tree', 'nonsense'], {}, {})).toBe('');
  });
});

