const V = chrome.runtime.getURL('viewer.html') + '?file=';

// web pdfs: redirect by content-type before chrome's viewer loads
chrome.runtime.onInstalled.addListener(() => chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: V + '\\0' } },
    condition: {
      regexFilter: '^https?://.*',
      resourceTypes: ['main_frame', 'sub_frame'],
      responseHeaders: [{ header: 'content-type', values: ['application/pdf*', 'application/x-pdf*'] }]
    }
  }]
}));

// local pdfs: only when "Allow access to file URLs" is on
chrome.webNavigation.onBeforeNavigate.addListener(async ({ tabId, frameId, url }) => {
  if (frameId === 0 && await chrome.extension.isAllowedFileSchemeAccess()) chrome.tabs.update(tabId, { url: V + url });
}, { url: [{ schemes: ['file'], pathSuffix: '.pdf' }, { schemes: ['file'], pathSuffix: '.PDF' }] });
