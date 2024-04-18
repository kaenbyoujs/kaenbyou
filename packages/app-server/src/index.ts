import { camelCase, Context, omit, sanitize, Schema, Session, snakeCase, Time, Universal, Dict, pick } from '@satorijs/satori'
import { } from '@cordisjs/server'
import { Query, $ } from 'minato'
import { Message } from '@kaenbyoujs/database'
import WebSocket from 'ws'

export const name = 'server'
export const inject = ['server', 'http', 'appdb', 'database']

const kClient = Symbol('state')

class Client {
  authorized = false
}

export interface ListParam {
  next?: string
}
export const ListParam: Schema<ListParam> = Schema.object({
  next: Schema.string().default("0"),
})

export interface MessageListParams extends ListParam {
  channel_id: string
}
export const MessageListParams: Schema<MessageListParams> = Schema.intersect([
  Schema.object({
    channel_id: Schema.string().required()
  }),
  ListParam,
])

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

  ctx.server.get(path + '/v1(/.+)*', async (koa) => {
    koa.body = 'Please use POST method to send requests.'
    koa.status = 405
  })

  ctx.server.post(path + '/v1/:name', async (koa) => {
    const method = Universal.Methods[koa.params.name]
    if (!method) {
      koa.body = 'method not found'
      return koa.status = 404
    }

    if (config.token) {
      if (koa.request.headers.authorization !== `Bearer ${config.token}`) {
        koa.body = 'invalid token'
        return koa.status = 403
      }
    }


    const json = koa.request.body
    const selfId = koa.request.headers['x-self-id']
    const platform = koa.request.headers['x-platform']
    const bot = ctx.bots.find(bot => bot.selfId === selfId && bot.platform === platform)
    if (!bot) {
      koa.body = 'bot not found'
      return koa.status = 403
    }

    const args = method.fields.map(({ name }) => {
      return transformKey(json[name], camelCase)
    })
    const result = await bot[method.name](...args)
    koa.body = transformKey(result, snakeCase)
    koa.status = 200
  })

  ctx.server.post(path + '/v1/app/message.list', async (koa) => {
    if (config.token) {
      if (koa.request.headers.authorization !== `Bearer ${config.token}`) {
        koa.body = 'invalid token'
        return koa.status = 403
      }
    }

    const json: MessageListParams = koa.request.body
    try {
      MessageListParams(json)
    } catch {
      koa.body = 'Bad request'
      return koa.status = 400
    }

    const query: Query<Message> = { 'channel.id': json.channel_id }
    if (json.next) {
      query.createdAt = { $gt: new Date(+json.next) }
    }

    const result = await ctx.database.select('@kaenbyoujs/messages@v1')
      .orderBy('createdAt')
      .limit(100)
      .execute()

    const last = result.at(-1)

    koa.body = {
      data: result,
      next: last && `${last.createdAt.getTime()}`
    }
    koa.status = 200
  })

  ctx.server.post(path + '/v1/app/contact.list', async (koa) => {
    if (config.token) {
      if (koa.request.headers.authorization !== `Bearer ${config.token}`) {
        koa.body = 'invalid token'
        return koa.status = 403
      }
    }

    // let json: ListParam = koa.request.body
    // try {
    //   json = ListParam(json)
    // } catch {
    //   koa.body = 'Bad request'
    //   return koa.status = 400
    // }

    const contacts: Dict<Contact> = {}
    for (const bot of ctx.bots) {
      for await (const guild of bot.getGuildIter()) {
        const { platform } = bot
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

        // handle the platform which don't have guild
        if (channels.length === 1 && channels[0].id === guild.id) {
          const [chan] = channels
          const id = `${platform}:${chan.id}`
          if (!contacts[id]) {
            contacts[id] = {
              id: chan.id,
              name: chan.name,
              platform,
              who_is_here: [],
              type: Contact.TypeMap.get(chan.type),
              avatar: guild.avatar,
            }
          }
          contacts[id].who_is_here.push(bot.selfId)
          continue
        }

        for (const chan of channels) {
          const id = `${bot.platform}:${chan.id}`
          if (!contacts[id]) {
            contacts[id] = {
              id: chan.id,
              name: chan.name,
              platform,
              who_is_here: [],
              type: Contact.TypeMap.get(chan.type),
              avatar: guild.avatar,
              parent: chan.parentId || guild.id,
              children: relation[chan.id]
            }
          }
          contacts[id].who_is_here.push(bot.selfId)
        }

        const id = `${bot.platform}:${guild.id}`
        if (!contacts[id]) {
          contacts[id] = {
            id: guild.id,
            name: guild.name,
            platform,
            who_is_here: [],
            type: Contact.Type.GUILD,
            avatar: guild.avatar,
            children: channels.map(chan => chan.id),
          }
        }
        contacts[id].who_is_here.push(bot.selfId)
      }
    }

    const update = await ctx.database.select('@kaenbyoujs/messages@v1')
      .groupBy(['channel.id', 'platform'], {
        id: row => $.concat(row.platform, ':', row.channel.id),
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
      contacts[chan.id] = {
        ...contacts[chan.id],
        ...omit(chan, ['id']),
      }
    }

    koa.body = {
      data: contacts,
    }
    koa.status = 200
  })

  ctx.server.post(path + '/v1/app/login', async (koa) => {
    if (config.token) {
      if (koa.request.headers.authorization !== `Bearer ${config.token}`) {
        koa.body = 'invalid token'
        return koa.status = 403
      }
    }

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

  ctx.server.post(path + '/v1/internal/:name', async (koa) => {
    const selfId = koa.request.headers['x-self-id']
    const platform = koa.request.headers['x-platform']
    const bot = ctx.bots.find(bot => bot.selfId === selfId && bot.platform === platform)
    if (!bot) {
      koa.body = 'bot not found'
      return koa.status = 403
    }

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
    for (const socket of layer.clients) {
      if (!socket[kClient]?.authorized) continue
      dispatch(socket, body)
    }
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
