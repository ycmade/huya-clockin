// ==UserScript==
// @name         虎牙粉丝徽章批量打卡
// @namespace    local.huya.badge-checkin
// @version      2.0.2
// @description  在 518518 直播间读取徽章列表，并使用主播 UID 直接调用虎牙签到服务。
// @author       local
// @match        https://www.huya.com/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // v3 曾误把 BadgeInfo.lUid（徽章所属用户）当成主播 UID。
    // 使用新键，避免升级后恢复已经生成错误 UID 的旧任务。
    var STORE_KEY = 'huya_badge_checkin_job_v4';
    var ENTRY_ROOM_URL = 'https://www.huya.com/518518';
    var ENTRY_ROOM_PATH = '/518518';
    var SCRIPT_VERSION = '2.0.2';
    var MAX_RETRY = 1;
    var WUP_TIMEOUT = 12000;
    var collecting = false;
    var processing = false;
    var panelMessage = '';
    var panelClosed = false;
    var panelMinimized = false;
    var clientPromise = null;

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function randomDelay(min, max) {
        return Math.floor(min + Math.random() * (max - min + 1));
    }

    function cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getPageWindow() {
        return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    }

    function primitive(value) {
        if (value === null || typeof value === 'undefined') return value;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
            return value;
        }
        try {
            var unwrapped = value.valueOf();
            if (unwrapped !== value) return unwrapped;
        } catch (error) {
            // 保留原值，交给 String/Number 做最后转换。
        }
        return value;
    }

    function idString(value) {
        var result = primitive(value);
        if (result === null || typeof result === 'undefined') return '';
        var text = String(result).trim();
        return text === '0' || text === 'NaN' || text === '[object Object]' ? '' : text;
    }

    function numberValue(value) {
        var result = Number(primitive(value));
        return Number.isFinite(result) ? result : 0;
    }

    function vectorValues(vector) {
        if (!vector) return [];
        var value = vector.value;
        if (!value) return [];
        try {
            return Array.prototype.slice.call(value);
        } catch (error) {
            return [];
        }
    }

    function getJob() {
        var job = GM_getValue(STORE_KEY, null);
        return job && Array.isArray(job.items) ? job : null;
    }

    function saveJob(job) {
        job.updatedAt = Date.now();
        GM_setValue(STORE_KEY, job);
    }

    function newId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function loginOrCaptchaMessage() {
        var bodyText = cleanText(document.body && document.body.innerText);
        if (/安全验证|请完成验证|验证码|滑动验证/.test(bodyText)) {
            return '遇到安全验证，请人工完成后再继续';
        }
        if (/登录后体验更多|扫码登录|密码登录/.test(bodyText)) {
            return '登录状态可能失效，请重新登录虎牙';
        }
        return '';
    }

    function getTtpClient() {
        if (clientPromise) return clientPromise;

        clientPromise = new Promise(function (resolve, reject) {
            var startedAt = Date.now();
            var settled = false;

            function finish(error, client) {
                if (settled) return;
                settled = true;
                if (error) {
                    clientPromise = null;
                    reject(error);
                } else {
                    resolve(client);
                }
            }

            function connect() {
                var page = getPageWindow();
                var ttp;
                try {
                    ttp = page.TTP;
                } catch (error) {
                    finish(new Error('无法访问虎牙页面的 TTP 对象，请确认油猴允许此脚本访问页面环境'));
                    return;
                }

                if (!ttp || typeof ttp.ready !== 'function') {
                    if (Date.now() - startedAt >= 20000) {
                        finish(new Error('等待虎牙 TTP 客户端超时，请刷新直播间后重试'));
                        return;
                    }
                    setTimeout(connect, 250);
                    return;
                }

                try {
                    ttp.ready(function (client) {
                        waitUntilUsable(client);
                    });
                } catch (error) {
                    finish(new Error('连接虎牙 TTP 客户端失败：' + error.message));
                }
            }

            function waitUntilUsable(client) {
                if (settled) return;
                if (Date.now() - startedAt >= 20000) {
                    finish(new Error('虎牙 TTP/TAF 客户端初始化超时，请刷新直播间后重试'));
                    return;
                }
                try {
                    if (!client || typeof client.sendWup2 !== 'function') {
                        setTimeout(function () { waitUntilUsable(client); }, 250);
                        return;
                    }
                    if (!client.taf || !client.taf.HUYA) {
                        setTimeout(function () { waitUntilUsable(client); }, 250);
                        return;
                    }
                    if (!client.userId || !idString(client.userId.lUid)) {
                        setTimeout(function () { waitUntilUsable(client); }, 250);
                        return;
                    }
                    finish(null, client);
                } catch (error) {
                    finish(new Error('读取虎牙 TTP/TAF 客户端失败：' + error.message));
                }
            }

            connect();
        });

        return clientPromise;
    }

    async function sendWup(serviceName, functionName, requestType, fields) {
        var client = await getTtpClient();
        var RequestType = client.taf.HUYA[requestType];
        if (typeof RequestType !== 'function') {
            throw new Error('虎牙页面缺少请求类型 ' + requestType + '，可能已改版');
        }

        var request = new RequestType();
        Object.keys(fields).forEach(function (key) {
            request[key] = fields[key];
        });

        return new Promise(function (resolve, reject) {
            var settled = false;
            var timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                reject(new Error(functionName + ' 请求超时'));
            }, WUP_TIMEOUT);

            try {
                client.sendWup2(serviceName, functionName, request, function (response) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(response || {});
                });
            } catch (error) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error(functionName + ' 调用失败：' + error.message));
            }
        });
    }

    async function queryBadgeInfoList() {
        var accountProblem = loginOrCaptchaMessage();
        if (accountProblem) throw new Error(accountProblem);

        var client = await getTtpClient();
        var response = await sendWup('liveui', 'queryBadgeInfoList', 'BadgeInfoListReq', {
            tUserId: client.userId
        });
        var badges = vectorValues(response.vBadgeInfo);
        var seen = Object.create(null);

        var items = badges.map(function (badge) {
            var channel = badge.tChannelInfo || {};
            // BadgeInfo.lUid 是徽章所属用户 UID，同一账号的所有徽章都会相同；
            // getFansSign/setFansSign 需要的主播 UID 位于 tChannelInfo.lUid。
            var presenterUid = idString(channel.lUid);
            if (!presenterUid || seen[presenterUid]) return null;
            seen[presenterUid] = true;

            var roomId = idString(channel.iRoomId);
            return {
                id: presenterUid,
                presenterUid: presenterUid,
                roomId: roomId,
                roomUrl: roomId ? 'https://www.huya.com/' + encodeURIComponent(roomId) : '',
                nickname: cleanText(badge.sPresenterNickName) || ('主播 ' + presenterUid),
                badgeName: cleanText(badge.sBadgeName),
                status: 'pending',
                retry: 0,
                message: '等待处理'
            };
        }).filter(Boolean);

        if (!items.length) {
            throw new Error('queryBadgeInfoList 未返回可用的 tChannelInfo.lUid 主播 UID');
        }
        return items;
    }

    function signedToday(signInfo) {
        if (!signInfo) return false;
        var position = numberValue(signInfo.iPos);
        var flag = numberValue(signInfo.lSignInFlag);
        if (position < 1 || position > 31) return false;
        return Math.floor(flag / Math.pow(2, position - 1)) % 2 === 1;
    }

    function responseError(response, operation) {
        var code = numberValue(response && response.iCode);
        if (code === 0) return null;
        var message = cleanText(response && response.sMsg) || '服务返回失败';
        return new Error(operation + '失败：' + message + '（iCode=' + code + '）');
    }

    async function getFansSign(presenterUid) {
        var client = await getTtpClient();
        var response = await sendWup('wupui', 'getFansSign', 'GetFansSignReq', {
            tId: client.userId,
            lPid: Number(presenterUid)
        });
        var error = responseError(response, '查询打卡状态');
        if (error) throw error;
        return response.tSign;
    }

    async function setFansSign(presenterUid) {
        var client = await getTtpClient();
        var response = await sendWup('wupui', 'setFansSign', 'FansSignReq', {
            tId: client.userId,
            lPid: Number(presenterUid)
        });
        var error = responseError(response, '打卡');
        if (error) throw error;
        return response;
    }

    function shouldPauseForMessage(message) {
        return /登录|验证码|验证|风控|频繁|受限|账号异常/.test(String(message || ''));
    }

    async function directCheckin(item) {
        var accountProblem = loginOrCaptchaMessage();
        if (accountProblem) return { status: 'paused', message: accountProblem };

        try {
            var before = await getFansSign(item.presenterUid);
            if (signedToday(before)) {
                return { status: 'done', message: '今日已经打卡' };
            }

            await setFansSign(item.presenterUid);
            await sleep(500);

            try {
                var after = await getFansSign(item.presenterUid);
                if (signedToday(after)) {
                    return { status: 'done', message: '打卡成功并已验证' };
                }
            } catch (verifyError) {
                return {
                    status: 'done',
                    message: '打卡接口返回成功；二次验证失败：' + verifyError.message
                };
            }

            return { status: 'done', message: '打卡接口返回成功；状态可能稍后更新' };
        } catch (error) {
            if (/已.*(?:打卡|签到)|重复.*(?:打卡|签到)/.test(error.message)) {
                return { status: 'done', message: '服务器提示今日已经打卡' };
            }
            if (shouldPauseForMessage(error.message)) {
                return { status: 'paused', message: error.message };
            }
            return { status: 'failed', message: error.message };
        }
    }

    async function processJob(jobId) {
        if (processing) return;
        processing = true;

        try {
            while (true) {
                var job = getJob();
                if (!job || job.id !== jobId || job.cancelled || job.paused || job.finishedAt) break;

                var index = job.items.findIndex(function (item) {
                    return item.status === 'pending' || item.status === 'working';
                });
                if (index < 0) {
                    job.finishedAt = Date.now();
                    saveJob(job);
                    panelMessage = '全部徽章已处理完成';
                    renderPanel();
                    break;
                }

                var item = job.items[index];
                var itemId = item.id;
                item.status = 'working';
                item.message = '正在查询主播 UID ' + item.presenterUid + ' 的打卡状态';
                saveJob(job);
                renderPanel();

                await sleep(randomDelay(700, 1300));
                var result = await directCheckin(item);

                job = getJob();
                if (!job || job.id !== jobId || job.cancelled) break;
                index = job.items.findIndex(function (candidate) { return candidate.id === itemId; });
                if (index < 0) break;
                item = job.items[index];

                if (result.status === 'paused') {
                    item.status = 'pending';
                    item.message = result.message;
                    job.paused = true;
                    job.pauseReason = result.message;
                    saveJob(job);
                    renderPanel();
                    break;
                }

                if (result.status === 'failed' && item.retry < MAX_RETRY) {
                    item.retry += 1;
                    item.status = 'pending';
                    item.message = result.message + '，准备重试';
                    saveJob(job);
                    renderPanel();
                    await sleep(randomDelay(1800, 2800));
                    continue;
                }

                item.status = result.status;
                item.message = result.message;
                saveJob(job);
                renderPanel();
                await sleep(randomDelay(1600, 2800));
            }
        } finally {
            processing = false;
            renderPanel();
        }
    }

    function addPanelStyles() {
        if (document.getElementById('hy-badge-style')) return;
        var style = document.createElement('style');
        style.id = 'hy-badge-style';
        style.textContent = [
            '#hy-badge-panel{position:fixed;left:70px;bottom:18px;z-index:2147483647;width:420px;',
            'background:#18191c;color:#eee;border:1px solid #3c3d42;border-radius:10px;',
            'box-shadow:0 10px 32px rgba(0,0,0,.38);font:14px/1.5 Arial,"Microsoft YaHei",sans-serif;}',
            '#hy-badge-panel .hd{display:flex;align-items:center;gap:10px;padding:12px 14px;',
            'border-bottom:1px solid #34353a;font-weight:700;}',
            '#hy-badge-panel .title{flex:1;min-width:0;}',
            '#hy-badge-panel .window-actions{display:flex;gap:4px;}',
            '#hy-badge-panel .window-actions button{width:28px;height:28px;margin:0;padding:0;',
            'border-radius:5px;background:#34363d;color:#ddd;font-size:18px;line-height:28px;}',
            '#hy-badge-panel .window-actions button:hover{background:#50535c;}',
            '#hy-badge-panel .bd{padding:12px 14px;}',
            '#hy-badge-panel.minimized{width:420px;}',
            '#hy-badge-panel.minimized .hd{border-bottom:0;}',
            '#hy-badge-panel.minimized .bd{display:none;}',
            '#hy-badge-panel .msg{color:#bbb;margin:8px 0;max-height:78px;overflow:auto;}',
            '#hy-badge-panel .summary{color:#ffb23e;margin:6px 0;}',
            '#hy-badge-panel button{border:0;border-radius:5px;padding:7px 12px;margin:4px 6px 4px 0;',
            'cursor:pointer;background:#ff7a18;color:#fff;}',
            '#hy-badge-panel button.secondary{background:#4b4d55;}',
            '#hy-badge-panel button:disabled{opacity:.5;cursor:not-allowed;}',
            '#hy-badge-panel details{margin-top:8px;color:#bbb;}',
            '#hy-badge-panel ol{max-height:250px;overflow:auto;padding-left:24px;margin:8px 0;}',
            '#hy-badge-panel li{margin:4px 0;}',
            '#hy-badge-panel .meta{color:#858891;font-size:12px;}',
            '#hy-badge-panel .done{color:#72d572}.failed{color:#ff8585}.working{color:#ffd166}'
        ].join('');
        document.head.appendChild(style);
    }

    function ensurePanel() {
        addPanelStyles();
        var panel = document.getElementById('hy-badge-panel');
        if (!panel) {
            panel = document.createElement('section');
            panel.id = 'hy-badge-panel';
            panel.innerHTML = '<div class="hd"><span class="title">虎牙粉丝徽章批量打卡（UID 直调） v'
                + SCRIPT_VERSION + '</span><span class="window-actions">'
                + '<button id="hy-toggle-panel" type="button" title="最小化" aria-label="最小化">−</button>'
                + '<button id="hy-close-panel" type="button" title="关闭面板（刷新页面后恢复）" '
                + 'aria-label="关闭面板">×</button></span></div><div class="bd"></div>';
            document.body.appendChild(panel);

            panel.querySelector('#hy-toggle-panel').addEventListener('click', function () {
                panelMinimized = !panelMinimized;
                panel.classList.toggle('minimized', panelMinimized);
                var button = panel.querySelector('#hy-toggle-panel');
                button.textContent = panelMinimized ? '+' : '−';
                button.title = panelMinimized ? '展开' : '最小化';
                button.setAttribute('aria-label', button.title);
            });

            panel.querySelector('#hy-close-panel').addEventListener('click', function () {
                panelClosed = true;
                panel.remove();
            });
        }
        return panel.querySelector('.bd');
    }

    function renderPanel(extraMessage) {
        if (typeof extraMessage === 'string') panelMessage = extraMessage;
        if (panelClosed) return;
        var body = ensurePanel();
        var detailsOpen = Boolean(body.querySelector('details[open]'));
        var job = getJob();
        var items = job ? job.items : [];
        var done = items.filter(function (item) { return item.status === 'done'; }).length;
        var failed = items.filter(function (item) { return item.status === 'failed'; }).length;
        var waiting = items.length - done - failed;
        var activeJob = job && !job.finishedAt && !job.cancelled;
        var running = collecting || processing || (activeJob && !job.paused);
        var message = (job && job.pauseReason) || panelMessage;

        var list = items.map(function (item) {
            var room = item.roomId ? '房间 ' + item.roomId : '无房间号';
            return '<li class="' + escapeHtml(item.status) + '">'
                + escapeHtml(item.nickname) + (item.badgeName ? '【' + escapeHtml(item.badgeName) + '】' : '')
                + '<div class="meta">主播 UID ' + escapeHtml(item.presenterUid) + '；' + escapeHtml(room) + '</div>'
                + escapeHtml(item.message) + '</li>';
        }).join('');

        body.innerHTML = ''
            + '<div>从 518518 调用 queryBadgeInfoList，使用每枚徽章的主播 UID 直接打卡。</div>'
            + '<div>不打开其他直播间；只调用 getFansSign / setFansSign。</div>'
            + '<div class="summary">总计 ' + items.length + '；完成 ' + done
            + '；失败 ' + failed + '；待处理 ' + waiting + '</div>'
            + '<button id="hy-start"' + (running ? ' disabled' : '') + '>读取徽章并开始打卡</button>'
            + (activeJob ? '<button id="hy-pause" class="secondary">' + (job.paused ? '继续' : '暂停') + '</button>' : '')
            + (job ? '<button id="hy-clear" class="secondary">清除记录</button>' : '')
            + '<div class="msg">' + escapeHtml(message) + '</div>'
            + (items.length ? '<details' + (detailsOpen ? ' open' : '')
                + '><summary>查看明细</summary><ol>' + list + '</ol></details>' : '');

        var startButton = body.querySelector('#hy-start');
        if (startButton) startButton.addEventListener('click', startBatch);

        var pauseButton = body.querySelector('#hy-pause');
        if (pauseButton) pauseButton.addEventListener('click', function () {
            var current = getJob();
            if (!current) return;
            current.paused = !current.paused;
            current.pauseReason = current.paused ? '已由用户暂停' : '';
            saveJob(current);
            renderPanel(current.paused ? '已暂停；不会继续发送请求' : '已继续');
            if (!current.paused) processJob(current.id);
        });

        var clearButton = body.querySelector('#hy-clear');
        if (clearButton) clearButton.addEventListener('click', function () {
            var current = getJob();
            if (current) {
                current.cancelled = true;
                saveJob(current);
            }
            GM_deleteValue(STORE_KEY);
            renderPanel('记录已清除；当前请求结束后不会继续');
        });
    }

    async function startBatch() {
        if (collecting || processing) return;
        if (location.hostname !== 'www.huya.com' || location.pathname.replace(/\/+$/, '') !== ENTRY_ROOM_PATH) {
            location.href = ENTRY_ROOM_URL;
            return;
        }

        collecting = true;
        renderPanel('正在通过 queryBadgeInfoList 读取主播 UID 和房间号……');

        var items;
        try {
            items = await queryBadgeInfoList();
        } catch (error) {
            collecting = false;
            renderPanel('读取失败：' + error.message);
            return;
        }

        var job = {
            id: newId(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            paused: false,
            cancelled: false,
            pauseReason: '',
            items: items
        };
        saveJob(job);
        collecting = false;
        renderPanel('已读取 ' + items.length + ' 枚徽章，开始按主播 UID 直接打卡');
        processJob(job.id);
    }

    function initEntryRoom() {
        renderPanel('点击按钮后，将在当前页面直接完成批量打卡');
        var job = getJob();
        if (job && !job.finishedAt && !job.cancelled && !job.paused) {
            setTimeout(function () { processJob(job.id); }, 0);
        }
        setInterval(function () { renderPanel(); }, 3000);
    }

    function main() {
        if (location.hostname === 'www.huya.com'
            && location.pathname.replace(/\/+$/, '') === ENTRY_ROOM_PATH) {
            initEntryRoom();
        }
    }

    main();
}());
