// The only API the (sandboxed) renderer can use.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res?.ok) return res.data;
  const err = new Error(res?.error || "Something went wrong.");
  err.hint = res?.hint || null;
  throw err;
}

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("kta", {
  appInfo: () => call("app:info"),
  openDataFolder: () => call("app:openDataFolder"),

  devices: {
    get: () => call("devices:get"),
    scan: () => call("devices:scan"),
    import: (deviceId) => call("devices:import", deviceId),
    log: () => call("devices:log"),
    onState: (cb) => on("devices:state", cb),
    onLog: (cb) => on("devices:log", cb)
  },

  vocab: {
    openDialog: () => call("vocab:openDialog"),
    openFile: (file) => call("vocab:openPath", webUtils.getPathForFile(file)),
    onImported: (cb) => on("library:imported", cb)
  },

  snapshots: {
    list: () => call("snapshots:list"),
    remove: (id) => call("snapshots:remove", id)
  },

  library: {
    load: (snapshotId) => call("library:load", snapshotId),
    words: (opts) => call("library:words", opts),
    preview: (opts) => call("library:preview", opts)
  },

  apkg: {
    openDialog: () => call("apkg:openDialog"),
    openFile: (file) => call("apkg:openPath", webUtils.getPathForFile(file))
  },

  jobs: {
    list: () => call("jobs:list"),
    start: (opts) => call("jobs:start", opts),
    cancel: (jobId) => call("jobs:cancel", jobId),
    remove: (jobId) => call("jobs:remove", jobId),
    logs: (jobId) => call("jobs:logs", jobId),
    open: (jobId, what) => call("jobs:open", { jobId, what }),
    onUpdate: (cb) => on("jobs:update", cb),
    onProgress: (cb) => on("jobs:progress", cb),
    onLog: (cb) => on("jobs:log", cb)
  },

  settings: {
    get: () => call("settings:get"),
    save: (patch) => call("settings:save", patch),
    chooseOutputDir: () => call("settings:chooseOutputDir")
  },

  llm: {
    models: () => call("llm:models")
  }
});
