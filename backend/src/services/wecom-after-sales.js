import { Op } from 'sequelize';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { db, AfterSaleNotification as Notification, Order, Purchase } from '../models.js';
import { storedChannels } from '../lib/channels.js';

const MAX_ATTEMPTS = 5;
const INTERVAL_MS = 4000; // 单实例串行发送，每分钟最多15次（含重试）。
const webhookFor = (channelChange) =>
  channelChange ? config.wecom.channelChangeWebhook : config.wecom.webhook;
const enabled = () =>
  Boolean((config.wecom.webhook || config.wecom.channelChangeWebhook) && config.wecom.appUrl);

export function notificationSettings(webhook, appUrl) {
  const url = new URL(webhook);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'qyapi.weixin.qq.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/cgi-bin/webhook/send' ||
    !url.searchParams.get('key')
  )
    throw new Error('企业微信通知配置无效');
  const app = new URL(appUrl);
  if (
    !['http:', 'https:'].includes(app.protocol) ||
    app.username ||
    app.password ||
    app.pathname !== '/' ||
    app.search ||
    app.hash ||
    app.origin.length > 255
  )
    throw new Error('通知站点地址须为系统首页地址');
  return { webhook: url.href, appUrl: app.origin };
}

export function notificationContent(
  {
    ticketId,
    recordId,
    kind,
    shopName,
    orderNumber,
    walmartSku,
    purchaseChannel,
    actorName,
    content,
    imageCount,
    createdAt,
    channelChange,
    beforeChannels,
    targetChannels,
  },
  appUrl,
) {
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false,
  }).format(new Date(createdAt));
  const link = `${appUrl}/${channelChange ? 'channel-change-tickets' : 'purchase-after-sales'}?ticket=${ticketId}`;
  return [
    `【${channelChange ? '渠道变更' : '采购售后'}${kind === 'created' ? '新工单' : '新回复'}】`,
    `工单 #${ticketId} · 消息 #${recordId}`,
    `店铺：${shopName}`,
    `订单号：${orderNumber}`,
    `Walmart SKU：${walmartSku}`,
    `采购渠道：${
      (storedChannels(purchaseChannel) || [])
        .map((channel) => channel.trim())
        .filter(Boolean)
        .join(' / ') || '未分配'
    }`,
    ...(channelChange
      ? [
          `变更前采购渠道：${beforeChannels?.join(' / ') || '未分配'}`,
          `目标采购渠道：${targetChannels?.join(' / ') || '待分配'}`,
        ]
      : []),
    `发送人：${actorName}`,
    `时间：${time}（北京）`,
    `内容：${content}`,
    ...(imageCount ? [`附图：${imageCount} 张`] : []),
    `查看工单：${link}`,
  ].join('\n');
}

const imagePattern = /^\/uploads\/images\/[0-9a-f-]{36}\.webp$/;
const combinedImagePath = (imagePath) => {
  if (!imagePattern.test(imagePath)) throw new Error('INVALID_IMAGE_PATH');
  return imagePath.replace(/\.webp$/, '.wecom.jpg');
};

// 内容按字符转义，避免用户输入被解释成图片、链接或格式；图片语法不可拆断。
export function notificationParts(
  content,
  images,
  ticketId,
  recordId,
  appUrl,
  channelChange = false,
) {
  const origin = new URL(appUrl).origin;
  const link = `${origin}/${channelChange ? 'channel-change-tickets' : 'purchase-after-sales'}?ticket=${ticketId}`;
  const plain = content.endsWith(`查看工单：${link}`)
    ? content.slice(0, -`查看工单：${link}`.length)
    : content;
  const tokens = [...plain].map((character) => ({
    text: /[\\`*_{}\[\]()#+\-.!|<>]/.test(character) ? `\\${character}` : character,
  }));
  tokens.push({ text: `\n[查看工单](${link})\n` });
  images.forEach((imagePath, index) =>
    tokens.push({
      text: `\n![售后图片${index + 1}](${origin}${combinedImagePath(imagePath)})\n`,
      imagePath,
    }),
  );
  const chunks = [];
  let chunk = { text: '', images: [] },
    bytes = 0;
  for (const token of tokens) {
    const size = Buffer.byteLength(token.text);
    if (bytes + size > 3800) {
      chunks.push(chunk);
      chunk = { text: '', images: [] };
      bytes = 0;
    }
    chunk.text += token.text;
    if (token.imagePath) chunk.images.push(token.imagePath);
    bytes += size;
  }
  if (chunk.text) chunks.push(chunk);
  return chunks.map((chunk, index) => ({
    msgtype: 'markdown_v2',
    markdown_v2: {
      content:
        chunks.length === 1
          ? chunk.text
          : `【工单 ${ticketId} · 消息 ${recordId} · ${index + 1}/${chunks.length}】\n${chunk.text}`,
    },
    images: chunk.images,
  }));
}

// 只读取系统持久化原图，不通过公网或浏览器地址获取，也不修改原图。
export async function notificationImage(imagePath, storage = config.storage, jpeg = false) {
  if (!imagePattern.test(imagePath)) throw new Error('INVALID_IMAGE_PATH');
  const source = await readFile(path.join(storage, 'images', path.basename(imagePath)));
  const { default: sharp } = await import('sharp');
  const pipeline = sharp(source, { limitInputPixels: 40000000, failOn: 'error' }).rotate();
  const limit = 2 * 1024 * 1024;
  let buffer = await (
    jpeg
      ? pipeline.clone().flatten({ background: '#ffffff' }).jpeg({ quality: 90 })
      : pipeline.clone().png()
  ).toBuffer();
  if (buffer.length > limit) {
    for (const [width, quality] of [
      [2200, 90],
      [2200, 75],
      [1600, 75],
      [1200, 65],
    ]) {
      buffer = await pipeline
        .clone()
        .resize(width, width, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality })
        .toBuffer();
      if (buffer.length <= limit) break;
    }
  }
  if (buffer.length > limit) throw new Error('IMAGE_TOO_LARGE');
  return {
    msgtype: 'image',
    image: {
      base64: buffer.toString('base64'),
      md5: createHash('md5').update(buffer).digest('hex'),
    },
  };
}

// 沿用现有静态图片目录生成持久化JPEG，供微信直接加载；只为待发送图片生成。
export async function prepareNotificationImage(imagePath, storage = config.storage) {
  const relative = combinedImagePath(imagePath);
  const target = path.join(storage, 'images', path.basename(relative));
  try {
    if ((await stat(target)).size > 0) return relative;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const payload = await notificationImage(imagePath, storage, true);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, Buffer.from(payload.image.base64, 'base64'));
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return relative;
}

// 与沟通记录同事务写入，提交后由后台发送；同一recordId只入队一次。
export async function queueAfterSaleNotification(
  ticket,
  item,
  record,
  kind,
  transaction,
  channelChange = false,
) {
  if (!config.wecom.appUrl || !webhookFor(channelChange)) return;
  let settings;
  try {
    settings = notificationSettings(webhookFor(channelChange), config.wecom.appUrl);
  } catch {
    console.error('企业微信通知配置无效，跳过通知入队');
    return;
  }
  const order = await Order.findByPk(item.orderId, { attributes: ['orderNumber'], transaction });
  // 与工单记录同事务读取并保存快照，排队及重试不重新读取后续修改的采购信息。
  const purchase = await Purchase.findOne({
    where: { itemId: item.id },
    attributes: ['purchaseChannel'],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const content = notificationContent(
    {
      ticketId: ticket.id,
      recordId: record.id,
      kind,
      shopName: item.shopName,
      orderNumber: order.orderNumber,
      walmartSku: item.walmartSku,
      purchaseChannel: purchase?.purchaseChannel,
      actorName: record.actorName,
      content: record.content,
      imageCount: record.images.length,
      createdAt: record.createdAt,
      channelChange,
      beforeChannels: ticket.beforeChannels,
      targetChannels: ticket.targetChannels,
    },
    settings.appUrl,
  );
  await Notification.create(
    {
      ticketId: ticket.id,
      ...(channelChange ? { channelChangeRecordId: record.id } : { recordId: record.id }),
      content,
      parts: notificationParts(
        content,
        record.images,
        ticket.id,
        record.id,
        settings.appUrl,
        channelChange,
      ),
    },
    { transaction },
  );
}

export async function sendWecom(content, webhook, transport = fetch) {
  try {
    const response = await transport(webhook, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        typeof content === 'string' ? { msgtype: 'text', text: { content } } : content,
      ),
    });
    if (!response.ok) return { ok: false, error: `HTTP_${response.status}` };
    const data = await response.json();
    return data.errcode === 0
      ? { ok: true }
      : {
          ok: false,
          error: Number.isInteger(data.errcode) ? `WECOM_${data.errcode}` : 'INVALID_RESPONSE',
        };
  } catch {
    // 不保存异常原文或企业微信errmsg，避免日志带出Webhook密钥。
    return { ok: false, error: 'NETWORK_OR_RESPONSE_ERROR' };
  }
}

export async function deliverAfterSaleNotification(transport = fetch, now = new Date()) {
  if (!enabled()) return false;
  const notification = await db.transaction(async (transaction) => {
    const row = await Notification.findOne({
      where: {
        status: 'pending',
        nextAttemptAt: { [Op.lte]: now },
        ...(!config.wecom.webhook
          ? { channelChangeRecordId: { [Op.ne]: null } }
          : !config.wecom.channelChangeWebhook
            ? { channelChangeRecordId: null }
            : {}),
      },
      order: [['id', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) return null;
    if (row.attempts >= MAX_ATTEMPTS) {
      await row.update({ status: 'failed', lastError: 'RETRY_EXHAUSTED' }, { transaction });
      return null;
    }
    await row.update(
      { attempts: row.attempts + 1, nextAttemptAt: new Date(now.getTime() + 120000) },
      { transaction },
    );
    return row;
  });
  if (!notification) return false;
  // 兼容旧版已入队的文本通知；进度逐条落库，重启/重试不从第一段重发。
  const parts = notification.parts || [
    { msgtype: 'text', text: { content: notification.content } },
  ];
  let result;
  try {
    const settings = notificationSettings(
      webhookFor(notification.channelChangeRecordId != null),
      config.wecom.appUrl,
    );
    const part = parts[notification.nextPart];
    let payload = part;
    if (part.msgtype === 'markdown_v2') {
      for (const imagePath of part.images || []) await prepareNotificationImage(imagePath);
      payload = { msgtype: 'markdown_v2', markdown_v2: part.markdown_v2 };
    } else if (part.msgtype === 'image') payload = await notificationImage(part.path);
    result = await sendWecom(payload, settings.webhook, transport);
  } catch {
    result = { ok: false, error: 'IMAGE_OR_PART_UNAVAILABLE' };
  }
  const nextPart = notification.nextPart + 1;
  const complete = nextPart >= parts.length;
  await notification.update(
    result.ok
      ? {
          nextPart,
          status: complete ? 'sent' : 'pending',
          sentAt: complete ? new Date() : null,
          lastError: null,
          attempts: complete ? notification.attempts : 0,
          nextAttemptAt: new Date(),
        }
      : {
          status: notification.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          lastError: result.error,
          nextAttemptAt: new Date(
            Date.now() + Math.min(3600000, 60000 * 2 ** (notification.attempts - 1)),
          ),
        },
  );
  return true;
}

export function startAfterSaleNotifications() {
  if (!enabled()) return async () => {};
  try {
    for (const webhook of [config.wecom.webhook, config.wecom.channelChangeWebhook].filter(Boolean))
      notificationSettings(webhook, config.wecom.appUrl);
  } catch {
    console.error('企业微信通知配置无效，推送未启动');
    return async () => {};
  }
  let running = null,
    lastCleanup = 0;
  const tick = () => {
    if (running) return;
    running = (async () => {
      await deliverAfterSaleNotification();
      if (Date.now() - lastCleanup > 3600000) {
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - 2);
        await Notification.destroy({
          where: {
            status: { [Op.in]: ['sent', 'failed'] },
            updatedAt: { [Op.lt]: cutoff },
          },
          limit: 500,
        });
        lastCleanup = Date.now();
      }
    })()
      .catch(() => console.error('企业微信售后通知处理失败，将稍后重试'))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
