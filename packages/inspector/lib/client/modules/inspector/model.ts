import { event, reaction, store } from "@virentia/core";

export const recordingChanged = event<boolean>("inspector.recordingChanged");
export const $recording = store(true, undefined, { name: "inspector.recording" });

reaction({
  on: recordingChanged,
  name: "inspector.applyRecording",
  run(value) {
    $recording.value = value;
  },
});
