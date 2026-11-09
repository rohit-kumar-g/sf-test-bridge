const $ = (id) => document.getElementById(id);
const bg = (msg) => chrome.runtime.sendMessage(msg);

async function render() {
  const s = await bg({ cmd: 'status' });
  $('dot').className = 'dot' + (s.connected ? ' on' : '');
  $('browser').textContent = s.browser;
  $('conn').innerHTML = s.connected
    ? `Connected to Claude on port ${s.port}.`
    : `Not connected. Claude Code starts the hub when it loads the <code>browser</code> MCP server.<br><span class="muted">${s.lastError || ''}</span>`;
  $('pause').textContent = s.paused ? 'Resume Claude' : 'Pause Claude';
  $('pause').onclick = async () => { await bg({ cmd: 'setPaused', value: !s.paused }); render(); };

  const cur = s.currentTab;
  $('cur').textContent = cur ? (cur.title || cur.url) : '-';
  $('share').disabled = !cur;
  $('share').textContent = cur?.controlled ? (cur.controlled === 'user' ? 'Stop sharing this tab' : 'Take this tab back from Claude') : 'Let Claude control this tab';
  $('share').onclick = async () => {
    await bg({ cmd: cur.controlled ? 'unshare' : 'share', tabId: cur.id });
    render();
  };

  $('tabs').innerHTML = '';
  for (const t of s.tabs) {
    const li = document.createElement('li');
    li.textContent = `#${t.tabId} ${t.title || t.url} (${t.controlled})`;
    $('tabs').append(li);
  }
  if (!s.tabs.length) $('tabs').innerHTML = '<li class="muted">none</li>';

  $('openMode').value = s.openMode;
  $('port').value = s.port;
}

$('reconnect').onclick = async () => { await bg({ cmd: 'reconnect' }); setTimeout(render, 600); };
$('openMode').onchange = (e) => bg({ cmd: 'setOpenMode', value: e.target.value });
$('savePort').onclick = async () => { await bg({ cmd: 'setPort', value: $('port').value }); setTimeout(render, 600); };
render();
