const msgInput = document.getElementById('msg');
const sendBtn = document.getElementById('send');
const status = document.getElementById('status');

sendBtn.addEventListener('click', async () => {
  const message = msgInput.value.trim();
  if (!message) {
    status.textContent = 'Message is empty.';
    return;
  }

  // Find the active Telegram Web tab
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: 'https://web.telegram.org/*'
  });

  if (!tab) {
    status.textContent = 'Please open Telegram Web in a tab first.';
    return;
  }

  // Send the message to the content script
  chrome.tabs.sendMessage(tab.id, { action: 'sendMessage', text: message }, (response) => {
    if (chrome.runtime.lastError) {
      status.textContent = 'Error: Could not communicate with the page.';
      return;
    }
    if (response && response.success) {
      status.textContent = 'Message sent!';
      msgInput.value = '';
    } else {
      status.textContent = 'Failed to send. Make sure a chat is open.';
    }
  });
});