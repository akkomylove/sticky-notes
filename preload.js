'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sticky', {
  load: (id) => ipcRenderer.invoke('note:load', id),
  create: (patch) => ipcRenderer.invoke('note:create', patch || {}),
  patch: (id, patch) => ipcRenderer.invoke('note:patch', { id, patch }),
  remove: (id) => ipcRenderer.invoke('note:delete', id),
  complete: (id) => ipcRenderer.invoke('note:complete', id),
  collapse: (id, collapsed) => ipcRenderer.invoke('window:collapse-self', { id, collapsed }),
  palette: () => ipcRenderer.invoke('palette:list'),

  archiveList: () => ipcRenderer.invoke('archive:list'),
  uncomplete: (id) => ipcRenderer.invoke('archive:uncomplete', id),
  restore: (id) => ipcRenderer.invoke('archive:restore', id),
  moveToTrash: (id) => ipcRenderer.invoke('archive:trash', id),
  purge: (id) => ipcRenderer.invoke('archive:purge', id),
  emptyTrash: () => ipcRenderer.invoke('archive:emptyTrash'),
  onArchiveRefresh: (cb) => ipcRenderer.on('archive:refresh', (_e, payload) => cb(payload)),

  attachFromClipboard: (id) => ipcRenderer.invoke('image:attach', { id }),
  attachFromBytes: (id, bytes) => ipcRenderer.invoke('image:attach', { id, bytes }),
  detachImage: (id, rel) => ipcRenderer.invoke('image:detach', { id, rel }),
  previewImage: (id, index) => ipcRenderer.invoke('image:preview', { id, index }),
  onPreview: (cb) => ipcRenderer.on('preview:show', (_e, payload) => cb(payload)),
  understand: (id) => ipcRenderer.invoke('ai:understand', { id }),

  settings: () => ipcRenderer.invoke('cfg:get'),
  saveSettings: (payload) => ipcRenderer.invoke('cfg:set', payload),
  listModels: () => ipcRenderer.invoke('models:list'),

  newNote: () => ipcRenderer.invoke('app:newNote'),
  newNoteFromClipboard: () => ipcRenderer.invoke('app:newNoteFromClipboard'),
  foldAll: (collapsed) => ipcRenderer.invoke('app:foldAll', collapsed),
  openData: () => ipcRenderer.invoke('app:openData'),
  quit: () => ipcRenderer.invoke('app:quit'),

  onUpdated: (cb) => ipcRenderer.on('note:updated', (_e, payload) => cb(payload)),
});
