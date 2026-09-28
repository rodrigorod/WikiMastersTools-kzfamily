(() => {
  const api =
    typeof browser !== 'undefined' && browser?.runtime
      ? browser
      : typeof chrome !== 'undefined' && chrome?.runtime
        ? chrome
        : null;

  if (!api?.runtime?.onMessage || !api?.tabs?.captureVisibleTab) return;

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'wm-capture-visible-tab') return undefined;

    const windowId = sender?.tab?.windowId;

    Promise.resolve(
      api.tabs.captureVisibleTab(windowId, {
        format: 'png'
      })
    ).then(
      (dataUrl) => sendResponse({ ok: true, dataUrl }),
      (error) => sendResponse({
        ok: false,
        error: String(error?.message || error)
      })
    );

    return true;
  });
})();