import { camelCase, Context, omit, sanitize, Schema, Session, snakeCase, Time, Universal, Dict, pick, Bot, Adapter } from '@satorijs/satori'
import { } from '@cordisjs/server'
import { Query, $, Direction } from 'minato'
import { Message } from '@kaenbyoujs/database'
import WebSocket from 'ws'

export const name = 'server'
export const inject = ['server', 'http', 'appdb', 'database']

const kClient = Symbol('state')

class Client {
  authorized = false
}

export interface MessageListParams {
  channel_id?: string
  direction?: Direction
  cursor?: number
}
export const MessageListParams: Schema<MessageListParams> = Schema.object({
  channel_id: Schema.string(),
  direction: Schema.union([
    Schema.const('desc'),
    Schema.const('asc')
  ]).default('desc'),
  cursor: Schema.number()
})

export interface LoginParams {
  config: any
  platform: string
}
export const LoginParams: Schema<LoginParams> = Schema.object({
  config: Schema.any().required(),
  platform: Schema.string().required(),
})

export interface Contact {
  id: string
  name: string
  platform: string
  who_is_here: string[]
  type: Contact.Type
  avatar?: string
  cover_user_name?: string
  cover_user_nick?: string
  cover_user_id?: string
  cover_message?: string
  update_time?: Date
  parent?: string | undefined
  children?: string[] | undefined
}

export namespace Contact {
  export enum Type {
    TEXT,
    DIRECT,
    CATEGORY,
    VOICE,
    GUILD,
  }

  export const TypeMap: Map<Universal.Channel.Type, Type> = new Map([
    [Universal.Channel.Type.TEXT, Type.TEXT],
    [Universal.Channel.Type.DIRECT, Type.DIRECT],
    [Universal.Channel.Type.CATEGORY, Type.CATEGORY],
    [Universal.Channel.Type.VOICE, Type.VOICE],
  ])
}

export interface ApiConfig {
  enabled?: boolean
}

export interface WebSocketConfig {
  enabled?: boolean
  resumeTimeout?: number
}

export interface Webhook {
  enabled?: boolean
  endpoint: string
  token?: string
}

export const Webhook: Schema<Webhook> = Schema.object({
  enabled: Schema.boolean().default(true),
  endpoint: Schema.string(),
  token: Schema.string(),
})

export interface Config {
  path: string
  token?: string
  api?: ApiConfig
  websocket?: WebSocketConfig
  webhooks: Webhook[]
}

export const Config: Schema<Config> = Schema.object({
  path: Schema.string().default('/satori'),
  token: Schema.string().experimental(),
  api: Schema.object({
    // enabled: Schema.boolean().default(true),
  }),
  websocket: Schema.object({
    // enabled: Schema.boolean().default(true),
    resumeTimeout: Schema.number().default(Time.minute * 5),
  }),
  webhooks: Schema.array(Webhook),
})

function transformKey(source: any, callback: (key: string) => string) {
  if (!source || typeof source !== 'object') return source
  if (Array.isArray(source)) return source.map(value => transformKey(value, callback))
  return Object.fromEntries(Object.entries(source).map(([key, value]) => {
    if (key.startsWith('_')) return [key, value]
    return [callback(key), transformKey(value, callback)]
  }))
}

export async function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('server')
  const path = sanitize(config.path)
  const buffer: Session[] = []
  const adapters = {
    dingtalk: require('@satorijs/adapter-dingtalk').default,
    discord: require('@satorijs/adapter-discord').default,
    kook: require('@satorijs/adapter-kook').default,
    lark: require('@satorijs/adapter-lark').default,
    line: require('@satorijs/adapter-line').default,
    mail: require('@satorijs/adapter-mail').default,
    matrix: require('@satorijs/adapter-matrix').default,
    satori: require('@satorijs/adapter-satori').default,
    slack: require('@satorijs/adapter-slack').default,
    telegram: require('@satorijs/adapter-telegram').default,
    whatsapp: require('@satorijs/adapter-whatsapp').default,
    zulip: require('@satorijs/adapter-zulip').default,
  }
  const layer = ctx.server.ws(path + '/v1/events', (socket) => {
    const client = socket[kClient] = new Client()

    socket.addEventListener('message', (event) => {
      let payload: Universal.ClientPayload
      try {
        payload = JSON.parse(event.data.toString())
      } catch (error) {
        return socket.close(4000, 'invalid message')
      }

      if (payload.op === Universal.Opcode.IDENTIFY) {
        if (config.token) {
          if (payload.body?.token !== config.token) {
            return socket.close(4004, 'invalid token')
          }
        }

        client.authorized = true
        socket.send(JSON.stringify({
          op: Universal.Opcode.READY,
          body: {
            logins: transformKey(ctx.bots.map(bot => bot.toJSON()), snakeCase),
          },
        }))
        if (!payload.body?.sequence) return
        for (const session of buffer) {
          if (session.id <= payload.body.sequence) continue
          dispatch(socket, transformKey(session.toJSON(), snakeCase))
        }
      } else if (payload.op === Universal.Opcode.PING) {
        socket.send(JSON.stringify({
          op: Universal.Opcode.PONG,
          body: {},
        }))
      }
    })
  })

  function dispatch(socket: WebSocket, body: any) {
    socket.send(JSON.stringify({
      op: Universal.Opcode.EVENT,
      body,
    }))
  }

  const broadcastAuthorized = (body:any) => {
    for (const socket of layer.clients) {
      if (!socket[kClient]?.authorized) continue
      dispatch(socket, body)
    }
  }

  // Authorization
  ctx.server.use(path + '/v1(/.+)*', async (koa, next) => {
    if (config.token) {
      if (koa.request.headers.authorization !== `Bearer ${config.token}`) {
        koa.body = 'invalid token'
        return koa.status = 403
      }
    }
    await next()
  })

  // Method Check
  ctx.server.get(path + '/v1(/.+)*', async (koa) => {
    koa.body = 'Please use POST method to send requests.'
    koa.status = 405
  })

  // Get Bot/Adapter Instance
  ctx.server.use([
    path + '/v1/:name',
    path + '/v1/internal/:name'
  ],
    async (koa, next) => {
      koa.matchedBot = ctx.bots
        .find(bot =>
          (bot.selfId == koa.request.headers['x-self-id'] && bot.platform == koa.request.headers['x-platform']) ||
          (`${bot.platform}:${bot.selfId}` == koa.request.headers['x-aid'])
        )

      koa.matchedAdapter =
        koa.matchedBot?.adapter

      await next()
    })

  ctx.server.post(path + '/v1/:name', async (koa) => {
    const method = Universal.Methods[koa.params.name]
    if (!method) {
      koa.body = 'method not found'
      return koa.status = 404
    }

    const json = koa.request.body
    const bot = koa.matchedBot

    const args = method.fields.map(({ name }) => {
      return transformKey(json[name], camelCase)
    })
    const result = await bot[method.name](...args)
    koa.body = transformKey(result, snakeCase)
    koa.status = 200
  })

  ctx.server.post(path + '/v1/app/message.get', async (koa) => {
    let json: MessageListParams = koa.request.body
    try {
      json = MessageListParams(json)
    } catch {
      koa.body = 'Bad request'
      return koa.status = 400
    }

    const query: Query<Message> = {}
    const platfrom = koa.request.headers['x-platform']
    if (json.channel_id) {
      query['channel.id'] = json.channel_id 
    }
    if (json.cursor) {
      if (json.direction === 'desc') {
        query.internalId = { $lt: json.cursor }
      } else {
        query.internalId = { $gt: json.cursor }
      }
    }
    if (platfrom) {
      query.platform = platfrom
    }

    let result = await ctx.database.select('@kaenbyoujs/messages@v1', query)
      .orderBy('createdAt', json.direction)
      .limit(45)
      .execute()

    koa.body = json.direction === 'desc' ? result : result.reverse()
    koa.status = 200
  })

  ctx.server.post(path + '/v1/app/contact.get', async (koa) => {
    const contacts: Dict<Contact> = {}
    for (const bot of ctx.bots) {
      const { platform } = bot
      for await (const guild of bot.getGuildIter()) {
        const channels: Universal.Channel[] = []
        const relation: Dict<string[]> = {}

        for await (const chan of bot.getChannelIter(guild.id)) {
          channels.push(chan)
          const { parentId: parent } = chan
          if (parent) {
            if (!relation[parent]) {
              relation[parent] = []
            }
            relation[parent].push(chan.id)
          }
        }

        // handle the platforms without a guild
        if (channels.length === 1 && channels[0].id === guild.id) {
          const [chan] = channels
          const id = `${platform}:${chan.id}`
          contacts[id] ??= {
            id: chan.id,
            name: chan.name ?? guild.name,
            platform,
            who_is_here: [],
            type: Contact.TypeMap.get(chan.type),
            avatar: guild.avatar,
          }
          contacts[id].who_is_here.push(bot.selfId)
          continue
        }

        for (const chan of channels) {
          const id = `${bot.platform}:${chan.id}`
          contacts[id] ??= {
            id: chan.id,
            name: chan.name ?? guild.name,
            platform,
            who_is_here: [],
            type: Contact.TypeMap.get(chan.type),
            avatar: guild.avatar,
            parent: chan.parentId || guild.id,
            children: relation[chan.id]
          }
          contacts[id].who_is_here.push(bot.selfId)
        }

        const id = `${bot.platform}:${guild.id}`
        contacts[id] ??= {
          id: guild.id,
          name: guild.name,
          platform,
          who_is_here: [],
          type: Contact.Type.GUILD,
          avatar: guild.avatar,
          children: channels.map(chan => chan.id),
        }
        contacts[id].who_is_here.push(bot.selfId)
      }

      for await (const user of bot.getFriendIter()) {
        const { id } = await bot.createDirectChannel(user.id)
        contacts[id] ??= {
          id: user.id,
          name: user.nick ?? user.name,
          platform,
          who_is_here: [],
          type: Contact.Type.DIRECT,
          avatar: user.avatar,
        }
        contacts[id].who_is_here.push(bot.selfId)
      }
    }

    const update = await ctx.database.select('@kaenbyoujs/messages@v1')
      .groupBy(['channel.id', 'platform'], {
        pid: row => $.concat(row.platform, ':', row.channel.id),
        cover_user_name: 'user.name',
        cover_user_nick: 'user.nick',
        cover_user_id: 'user.id',
        cover_message: 'content',
        update_time: row => $.max(row.createdAt),
      })
      // .limit(100)
      // .offset(+json.next)
      .execute()
      .then(data => data.map(d => omit(d, ['channel', 'platform'])))

    for (const chan of update) {
      contacts[chan.pid] = {
        ...contacts[chan.pid],
        ...chan,
      }

      // contacts[chan.id].id = contacts
    }

    koa.body = Object.values(contacts)
    koa.status = 200
  })

  ctx.server.post(path + '/v1/app/login', async (koa) => {

    const json: LoginParams = koa.request.body
    try {
      LoginParams(json)
    } catch {
      koa.body = 'Bad request'
      return koa.status = 400
    }

    const adapter = adapters[json.platform]

    if (!adapter) {
      koa.body = 'Unsupported platform'
      return koa.status = 403
    }

    const marker = Symbol('marker')
    ctx[marker] = true
    ctx.plugin(adapter, json.config)

    const login = await new Promise<Universal.Login>((resolve) => {
      const dispose = ctx.on('bot-status-updated', (bot) => {
        if (bot.ctx[marker]) {
          if (bot.status === Universal.Status.ONLINE) {
            resolve(pick(bot, ['user', 'selfId', 'platform', 'status']))
            dispose()
          }
        }
      })
    })

    koa.body = login
    return koa.status = 200
  })

  const loginCache = new WeakMap<Bot, Universal.Login>()

  ctx.server.post(path + '/v1/app/login.list', async (koa) => {
    const login = []
    for (const bot of ctx.bots) {
      if (!loginCache.has(bot)) {
        loginCache.set(bot, await bot.getLogin())
      }
      login.push(loginCache.get(bot))
    }
    koa.body = {
      data: login.map(v=>({
        ...v,
        aid: `${v.platform}:${v.selfId}`
      })),
      next: null
    }
    koa.status = 200
  })

  ctx.server.post(path + '/v1/internal/:name', async (koa) => {
    const bot = koa.matchedBot

    const name = camelCase(koa.params.name)
    if (!bot.internal?.[name]) {
      koa.body = 'method not found'
      return koa.status = 404
    }
    const result = await bot.internal[name](...koa.request.body)
    koa.body = result
    koa.status = 200
  })

  ctx.setInterval(() => {
    while (buffer[0]?.timestamp! + config.websocket?.resumeTimeout! < Date.now()) {
      buffer.shift()
    }
  }, Time.second * 10)

  ctx.on('internal/session', (session) => {
    const body = transformKey(session.toJSON(), snakeCase)
    broadcastAuthorized(body)
    for (const webhook of config.webhooks) {
      if (!webhook.enabled) continue
      ctx.http.post(webhook.endpoint, body, {
        headers: webhook.token ? {
          Authorization: `Bearer ${webhook.token}`,
        } : {},
      }).catch(logger.warn)
    }
  })
}
