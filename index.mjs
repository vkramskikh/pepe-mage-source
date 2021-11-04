import fs from 'fs';
import path from 'path';
import debug from 'debug';
import TelegramBot from 'node-telegram-bot-api';
import Datastore from 'nedb-promises';
import ExtendableError from 'es6-error';
import {map, find, pick, isString, isPlainObject, compact} from 'lodash-es';

const log = debug('pepe-mage-source');
const logError = debug('pepe-mage-source:error');
const logInfo = debug('pepe-mage-source:info');

class SerializationError extends ExtendableError {};

process.on('unhandledRejection', (error) => logError('unhandled rejection', error));

const cwd = path.dirname(process.argv[1]);

const config = JSON.parse(fs.readFileSync(path.join(cwd, 'config.json'), {encoding: 'utf8'}));

const {
  token: TOKEN,
  chatId: CHAT_ID,
  debug: DEBUG,
  minHour: MIN_HOUR = 5,
  maxHour: MAX_HOUR = 19,
  minPostCount: MIN_POST_COUNT = 4,
  maxPostCount: MAX_POST_COUNT = 5,
  postInterval: POST_INTERVAL = 90 * 60 * 1000,
  postIntervalOffset: POST_INTERVAL_OFFSET = POST_INTERVAL / 10,
  basePostChance: BASE_POST_CHANCE = 0.25,
  basePostChancePostCount: BASE_POST_CHANCE_POST_COUNT = 25,
  blacklistedChatIds: BLACKLISTED_CHAT_IDS = [],
} = config;

const db = Datastore.create(path.join(cwd, 'store.db'));
await db.load();

const bot = new TelegramBot(TOKEN, {polling: true, filepath: false});
bot.on('polling_error', (error) => {
  logError('polling error', error);
  process.exit(-1);
});

const administrators = await bot.getChatAdministrators(CHAT_ID);
const administratorsIds = map(administrators, ({user: {id}}) => id);
const ownerId = find(administrators, {status: 'creator'})?.user?.id;
if (!ownerId) throw new Error('No owner found');

bot.on('message', async (message) => {
  log(message);
  if (isString(message.text) && message.text[0] === '/') {
    handleCommand(message);
  } else {
    handleMedia(message);
  }
});

bot.on('callback_query', handleCallbackQuery);

let postTimer = null;

async function handlePostTimer() {
  try {
    const count = await db.count({type: 'message'});
    const postChance = Math.min(BASE_POST_CHANCE * (count / BASE_POST_CHANCE_POST_COUNT), 1);
    const now = new Date();
    const hour = now.getHours() + now.getTimezoneOffset() / 60;
    if (hour > MIN_HOUR && hour < MAX_HOUR && Math.random() < postChance) {
      await postRandomMessages(Math.round(MIN_POST_COUNT + Math.random() * (MAX_POST_COUNT - MIN_POST_COUNT)));
    }
  } finally {
    schedulePostTimer();
  }
}

function schedulePostTimer() {
  if (postTimer) clearTimeout(postTimer);
  postTimer = setTimeout(handlePostTimer, POST_INTERVAL + POST_INTERVAL_OFFSET * Math.random());
}

schedulePostTimer();

async function postRandomMessage() {
  const count = await db.count({type: 'message'});
  if (count > 0) {
    const doc = await db.findOne({type: 'message'}).skip(Math.floor(Math.random() * count));
    await sendSerializedMessage(DEBUG ? ownerId : CHAT_ID, doc.message);
    await db.remove({_id: doc._id});
  }
}

async function postRandomMessages(count) {
  for (let i = 0; i < count; i++) {
    await postRandomMessage();
  }
}

function pickMessageProps(message) {
  return message.forward_date ? {} : pick(message, ['caption', 'parse_mode', 'caption_entities']);
}

function serializeMessage(message) {
  if (message.media_group_id) {
    throw new SerializationError('Media groups are not supported yet :(');
  } else if (message.photo) {
    return ['sendPhoto', message.photo[0].file_id, pickMessageProps(message)];
  } else if (message.video) {
    return ['sendVideo', message.video.file_id, pickMessageProps(message)];
  } else if (message.animation) {
    return ['sendAnimation', message.animation.file_id, pickMessageProps(message)];
  } else if (message.text) {
    throw new SerializationError('No text only content :(');
  } else {
    throw new SerializationError('No allowed content found :(');
  }
}

function addAdminReplyMarkup(serializedMessage) {
  if (serializedMessage.length === 3 && isPlainObject(serializedMessage[2])) {
    const [method, fileId, options] = serializedMessage;
    return [method, fileId, {...options, reply_markup: {
      inline_keyboard: [[
        {text: 'Yes', callback_data: 'accept'},
        {text: 'No', callback_data: 'reject'},
      ]]
    }}];
  } else {
    return serializedMessage;
  }
}

function sendSerializedMessage(chatId, serializedMessage) {
  const [method, ...opts] = serializedMessage;
  return bot[method](chatId, ...opts);
}

function checkAdminRights(message) {
  return administratorsIds.includes(message.from.id);
}

function checkIfBlacklisted(message) {
  return !!message.forward_from_chat && BLACKLISTED_CHAT_IDS.includes(message.forward_from_chat.id);
}

function storeSerializedMessage(serializedMessage) {
  return db.insert({type: 'message', message: serializedMessage});
}

async function handleCommand(message) {
  const isAdmin = checkAdminRights(message);
  const command = message.text;
  let match = null;
  if (command === '/start') {
    if (!isAdmin) {
      return bot.sendMessage(message.chat.id, 'Hi! Send me some memes :)');
    } else {
      return bot.sendMessage(message.chat.id, 'Hi!', {reply_markup: {
        keyboard: [[
          {text: '/queue_info'},
          {text: '/random_post'},
        ]]
      }});
    }
  } else if (command === '/queue_info') {
    if (isAdmin) {
      const count = await db.count({type: 'message'});
      return bot.sendMessage(message.chat.id, `Message queue size: ${count}`);
    }
  } else if (match = command.match(/^\/random_post(?:\s+(\d+))?$/)) {
    if (isAdmin) {
      let count = 1;
      if (isString(match[1])) count = Number(match[1]);
      schedulePostTimer();
      return postRandomMessages(count);
    }
  }

  return bot.sendMessage(message.chat.id, 'Unknown command :(');
}

async function handleMedia(message) {
  const isAdmin = checkAdminRights(message);
  let serializedMessage = null;
  try {
    serializedMessage = serializeMessage(message);
  } catch (error) {
    if (error instanceof SerializationError) return bot.sendMessage(message.chat.id, error.message);
  }
  if (serializedMessage) {
    if (isAdmin) {
      await storeSerializedMessage(serializedMessage);
      await bot.deleteMessage(message.chat.id, message.message_id);
    } else {
      if (checkIfBlacklisted(message)) return bot.sendMessage(message.chat.id, 'This content is not welcome here :(');
      await sendSerializedMessage(ownerId, addAdminReplyMarkup(serializedMessage));
      await bot.sendMessage(message.chat.id, 'Thanks for your contribution!');
      logInfo(
        'New media from ' +
        (message.from.username ? '@' + message.from.username + ' ': '') +
        compact([message.from.first_name, message.from.last_name]).join(' ')
      );
    }
  }
}

async function handleCallbackQuery(callbackQuery) {
  const isAdmin = checkAdminRights(callbackQuery);
  if (isAdmin) {
    if (callbackQuery.data === 'accept') {
      let serializedMessage = null;
      try {
        serializedMessage = serializeMessage(callbackQuery.message);
      } catch (error) {
        if (error instanceof SerializationError) return bot.sendMessage(callbackQuery.message.chat.id, error.message);
      }
      await storeSerializedMessage(serializedMessage);
    }
    await bot.deleteMessage(callbackQuery.message.chat.id, callbackQuery.message.message_id);
  }
  bot.answerCallbackQuery(callbackQuery.id);
}
