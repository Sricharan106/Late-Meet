import assert from "node:assert/strict";
import test from "node:test";

import {
  connectMicrophoneToOffscreenAudioGraph,
  createOffscreenAudioGraph,
  MICROPHONE_AUDIO_CONSTRAINTS,
  OFFSCREEN_ANALYSER_FFT_SIZE,
} from "../src/offscreenAudioGraph.ts";

class MockAudioNode {
  readonly connections: MockAudioNode[] = [];

  connect(destination: MockAudioNode): MockAudioNode {
    this.connections.push(destination);
    return destination;
  }
}

class MockSourceNode extends MockAudioNode {
  constructor(readonly stream: MediaStream) {
    super();
  }
}

class MockAnalyserNode extends MockAudioNode {
  fftSize = 2048;
}

class MockMediaStreamDestinationNode extends MockAudioNode {
  readonly stream = createMockStream("recorder-output");
}

class MockAudioContext {
  readonly destination = new MockAudioNode();
  readonly analyser = new MockAnalyserNode();
  readonly recorderDestination = new MockMediaStreamDestinationNode();
  readonly sources: MockSourceNode[] = [];

  createMediaStreamDestination(): MediaStreamAudioDestinationNode {
    return this.recorderDestination as unknown as MediaStreamAudioDestinationNode;
  }

  createAnalyser(): AnalyserNode {
    return this.analyser as unknown as AnalyserNode;
  }

  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode {
    const source = new MockSourceNode(stream);
    this.sources.push(source);

    return source as unknown as MediaStreamAudioSourceNode;
  }
}

function createMockStream(id: string): MediaStream {
  return { id } as unknown as MediaStream;
}

function asAudioContext(context: MockAudioContext): AudioContext {
  return context as unknown as AudioContext;
}

test("creates one recorder destination and one analyser for tab capture", () => {
  const context = new MockAudioContext();
  const tabStream = createMockStream("tab");

  const graph = createOffscreenAudioGraph(asAudioContext(context), tabStream);

  assert.equal(graph.recorderDestination, context.recorderDestination);

  assert.equal(graph.analyser, context.analyser);
  assert.equal(graph.tabSource, context.sources[0]);
  assert.equal(context.sources.length, 1);
});

test("configures the analyser with the offscreen FFT size", () => {
  const context = new MockAudioContext();

  createOffscreenAudioGraph(asAudioContext(context), createMockStream("tab"));

  assert.equal(context.analyser.fftSize, OFFSCREEN_ANALYSER_FFT_SIZE);

  assert.equal(context.analyser.fftSize, 1024);
});

test("routes tab audio to recorder, analyser, and playback output", () => {
  const context = new MockAudioContext();

  createOffscreenAudioGraph(asAudioContext(context), createMockStream("tab"));

  assert.deepEqual(context.sources[0].connections, [
    context.recorderDestination,
    context.analyser,
    context.destination,
  ]);
});

test("routes microphone audio to recorder and analyser", () => {
  const context = new MockAudioContext();

  const graph = createOffscreenAudioGraph(asAudioContext(context), createMockStream("tab"));

  const microphoneSource = connectMicrophoneToOffscreenAudioGraph(
    asAudioContext(context),
    createMockStream("microphone"),
    graph,
  );

  assert.equal(microphoneSource, context.sources[1]);

  assert.deepEqual(context.sources[1].connections, [context.recorderDestination, context.analyser]);
});

test("does not route microphone audio to local playback", () => {
  const context = new MockAudioContext();

  const graph = createOffscreenAudioGraph(asAudioContext(context), createMockStream("tab"));

  connectMicrophoneToOffscreenAudioGraph(
    asAudioContext(context),
    createMockStream("microphone"),
    graph,
  );

  assert.equal(
    context.sources[1].connections.includes(context.destination),
    false,
    "microphone playback would create local monitoring or feedback",
  );
});

test("keeps tab and microphone source nodes independent", () => {
  const context = new MockAudioContext();
  const tabStream = createMockStream("tab");
  const microphoneStream = createMockStream("microphone");

  const graph = createOffscreenAudioGraph(asAudioContext(context), tabStream);

  connectMicrophoneToOffscreenAudioGraph(asAudioContext(context), microphoneStream, graph);

  assert.notEqual(context.sources[0], context.sources[1]);
  assert.equal(context.sources[0].stream, tabStream);
  assert.equal(context.sources[1].stream, microphoneStream);

  assert.equal(context.sources[0].connections.length, 3);
  assert.equal(context.sources[1].connections.length, 2);
});

test("enables microphone processing and automatic gain control", () => {
  assert.deepEqual(MICROPHONE_AUDIO_CONSTRAINTS, {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
});
