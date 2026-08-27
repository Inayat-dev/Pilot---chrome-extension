// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'sendMessage') {
    const result = sendTelegramMessage(request.text);
    sendResponse({ success: result });
  }
});

function sendTelegramMessage(text) {
  // Selectors for the message input and send button (may need updates over time)
  const inputSelector = 'div[contenteditable="true"][data-placeholder="Message"]';
  const sendButtonSelector = 'button[aria-label="Send message"], button[title="Send Message"]';

  const inputEl = document.querySelector(inputSelector);
  if (!inputEl) {
    console.error('Telegram Web input not found.');
    return false;
  }

  // Focus and clear the input
  inputEl.focus();
  // Clear existing text (simulate select all + delete)
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);

  // Insert the new text
  document.execCommand('insertText', false, text);

  // Give a tiny delay for the UI to update, then click send
  setTimeout(() => {
    const sendBtn = document.querySelector(sendButtonSelector);
    if (sendBtn) {
      sendBtn.click();
      return true;
    } else {
      // Fallback: try pressing Enter (if not a multiline chat)
      inputEl.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      }));
      return true;
    }
  }, 100);

  return true; // optimistically assume it will work
}