/** Pure validation and classification. No network or Google service calls. */
const NotificationCore = Object.freeze({
  validateLine(input, { allowEmptyToken = false } = {}) {
    if (!input || !['user', 'group'].includes(input.type)) throw new Error('通知先の種類が不正です。');
    if (typeof input.recipient !== 'string') throw new Error('通知先IDを文字列で入力してください。');
    const recipient = input.recipient.trim();
    const pattern = input.type === 'user' ? /^U[0-9a-f]{32}$/ : /^C[0-9a-f]{32}$/;
    if (!pattern.test(recipient)) throw new Error('通知先IDの形式が不正です。個人はU、グループはCで始まる33文字です。');
    if (typeof input.token !== 'string' || /[\x00-\x1f\x7f]/.test(input.token) || input.token.length > 4000) throw new Error('チャネルアクセストークンを正しく入力してください。');
    const token = input.token.trim();
    if ((!token && !allowEmptyToken) || /[\r\n]/.test(token) || token.length > 4000) throw new Error('チャネルアクセストークンを正しく入力してください。');
    return { type: input.type, recipient, token };
  },
  shouldNotify(event, config, seen) {
    return !!(event.id && !seen && event.status !== 'cancelled' && !event.recurringEventId &&
      Date.parse(event.created) > Date.parse(config.startedAt) &&
      String(event.summary || '').startsWith(config.prefix));
  },
  message(event) {
    const lines = ['カレンダーに予定が追加されました', this.truncateText(String(event.summary || '（件名なし）'), 500), this.dateRange(event)];
    const video = ((event.conferenceData || {}).entryPoints || []).find(point => point.entryPointType === 'video' && this.isWebUrl(point.uri));
    const meeting = video ? video.uri : (this.isWebUrl(event.hangoutLink) ? event.hangoutLink : '');
    if (meeting) lines.push('', 'ミーティングURL', meeting);
    if (/^https:\/\/calendar\.google\.com\/[^\s<>]*$/.test(event.htmlLink || '')) lines.push('', '予定を開く', event.htmlLink);
    const note = this.noteText(event.description);
    if (note) lines.push('', 'メモ', note);
    return this.truncateText(lines.join('\n'), 4900);
  },
  truncateText(text, limit) {
    if (text.length <= limit) return text;
    const suffix = '\n（文字数上限のため省略）';
    return text.slice(0, limit - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
  },
  isWebUrl(value) {
    return typeof value === 'string' && value.length <= 2048 && /^https?:\/\/[^\s<>]+$/.test(value);
  },
  dateRange(event) {
    const start = event.start || {};
    const end = event.end || {};
    const pad = value => String(value).padStart(2, '0');
    const dateLabel = (date, year) => (year ? date.getUTCFullYear() + '-' : '') + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate()) + '(' + '日月火水木金土'[date.getUTCDay()] + ')';
    const timeLabel = date => pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes());
    const dateOnly = value => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const date = new Date(value + 'T00:00:00Z');
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
    };
    if (start.date) {
      const first = dateOnly(start.date);
      if (!first) return '日時未設定';
      const exclusive = dateOnly(end.date);
      const last = exclusive && exclusive > first ? new Date(exclusive.getTime() - 86400000) : first;
      const crossYear = first.getUTCFullYear() !== last.getUTCFullYear();
      return dateLabel(first, crossYear) + (first.getTime() !== last.getTime() ? '〜' + dateLabel(last, crossYear) : '') + ' 終日';
    }
    const japanTime = value => {
      if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? new Date(ms + 9 * 3600000) : null;
    };
    const first = japanTime(start.dateTime);
    const last = event.endTimeUnspecified ? null : japanTime(end.dateTime);
    if (!first) return '日時未設定';
    const crossYear = !!last && first.getUTCFullYear() !== last.getUTCFullYear();
    const firstText = dateLabel(first, crossYear) + ' ' + timeLabel(first);
    if (!last) return firstText;
    const sameDay = first.toISOString().slice(0, 10) === last.toISOString().slice(0, 10);
    return firstText + '〜' + (sameDay ? '' : dateLabel(last, crossYear) + ' ') + timeLabel(last);
  },
  decodeHtml(text) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, key) => {
      if (key[0] !== '#') return named[key.toLowerCase()] || whole;
      const value = /^#x/i.test(key) ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : whole;
    });
  },
  noteText(description) {
    let text = String(description || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attrs, label) => {
      const match = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const url = match ? this.decodeHtml(match[1] || match[2] || match[3] || '') : '';
      const title = this.decodeHtml(label.replace(/<[^>]*>/g, '')).trim();
      return this.isWebUrl(url) ? (title && title !== url ? title + ' (' + url + ')' : url) : title;
    });
    text = text.replace(/<br\b[^>]*>/gi, '\n').replace(/<li\b[^>]*>/gi, '\n・')
      .replace(/<\/(?:p|div|li|ul|ol|h[1-6])\s*>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '');
    return this.decodeHtml(text).replace(/\r\n?/g, '\n').replace(/[\t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  },
  validateSettings(calendarId, prefix) {
    calendarId = String(calendarId || '').trim();
    prefix = String(prefix || '');
    if (!calendarId) throw new Error('対象カレンダーを入力してください。');
    if (!prefix.trim()) throw new Error('接頭辞を入力してください。');
    if (calendarId.length > 1024 || prefix.length > 200) throw new Error('設定値が長すぎます。');
    return { calendarId, prefix };
  },
});
