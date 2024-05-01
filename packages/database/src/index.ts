import { Context, Logger, Service, Universal } from '@satorijs/core'
import { makeArray, MaybeArray } from 'cosmokit'
import { $, Update } from 'minato'
import {} from '@cordisjs/timer'
import Schema from 'schemastery'

const logger = new Logger('app-database')

declare module '@satorijs/core' {
  
  interface Context {
    appdb: AppDatabase
  }
}

declare module 'minato' {
  interface Tables {
    '@kaenbyoujs/messages@v1': Message
  }
}

export interface Message {
  internalId: number // before: id
  content: string
  id: string // before: messageId
  platform: string
  quote?: string
  createdAt: Date
  updatedAt?: Date
  deleted: boolean
  edited: boolean
  channel: {
    id: string
  }
  guild: {
    id: string
  }
  user: {
    id: string
    name: string
    is_bot: boolean
    nick?: string
    avatar?: string
  }
}

export interface History {
  id: number
  parent: number
  content: string
}

interface Task {
  channelId: string
  guildId: string
  selfId: string
  final: string
  next?: string
}

class AppDatabase extends Service {
  constructor(public ctx: Context, public config: AppDatabase.Config) {
    super(ctx, 'appdb')
    const queue: Task[] = []

    const upsert = async (msg: MaybeArray<Update<Message>>) => {
      const messages = makeArray(msg)
      await ctx.database.upsert('@kaenbyoujs/messages@v1', messages, ['channel.id', 'id', 'platform'])
    }

    ctx.database.extend('@kaenbyoujs/messages@v1', {
      internalId: {
        type: 'unsigned',
        length: 8,
      },
      content: 'text',
      id: 'string',
      platform: 'string',
      createdAt: 'timestamp',
      quote: 'string',
      'channel.id': 'string',
      'guild.id': 'string',
      updatedAt: 'timestamp',
      deleted: {
        type: 'boolean',
        initial: false,
      },
      edited: {
        type: 'boolean',
        initial: false,
      },
      'user.id': 'string',
      'user.avatar': 'string',
      'user.name': 'string',
      'user.nick': 'string',
      'user.is_bot': {
        type: 'boolean',
        initial: false,
      }
    }, {
      autoInc: true,
      primary: 'internalId',
      unique: [['platform', 'channel.id', 'id']],
    })

    ctx.on('bot-status-updated', async (bot) => {
      if (bot.status !== Universal.Status.ONLINE) return
      const support = await bot.supports('guild.list') && await bot.supports('message.list')
      if (!support) return
      for await (const guild of bot.getGuildIter()) {
        const [last] = await ctx.database.select('@kaenbyoujs/messages@v1')
        .where({ platform: bot.platform, 'guild.id': guild.id })
        .groupBy(['channel.id'], {
          channelId: 'channel.id',
          guildId: 'guild.id',
          final: 'id',
          time: row => $.max(row.createdAt),
        })
        .execute()

        if (!last) continue

        queue.push({ ...(last as any), selfId: bot.selfId })
      }
    })

    ctx.on('message', async (session) => {
      const { content, messageId, platform, guildId, channelId } = session
      const { createdAt, updatedAt } = session.event?.message ?? {}
      const { user, member } = session.event
      await upsert({
        content,
        id: messageId,
        platform,
        'channel.id': channelId,
        'guild.id': guildId,
        edited: updatedAt ? createdAt !== updatedAt : false,
        quote: session.quote?.id,
        createdAt: new Date(createdAt ?? Date.now()),
        updatedAt: new Date(createdAt ?? Date.now()),
        'user.id': user.id,
        'user.avatar': member?.avatar || user?.avatar,
        'user.name': member?.name || user?.name,
        'user.nick': member?.nick || user?.nick,
      })
    })

    ctx.on('message-deleted', async (session) => {
      const msg = session.event.message
      await ctx.database.set('@kaenbyoujs/messages@v1', { id: msg.id, 'channel.id': session.channelId, platform: session.platform }, {
        updatedAt: new Date(msg.updatedAt ?? Date.now()),
        deleted: true,
      })
    })

    ctx.on('message-updated', async (session) => {
      const msg = session.event.message
      await ctx.database.set('@kaenbyoujs/messages@v1', { id: msg.id, 'channel.id': session.channelId, platform: session.platform }, {
        content: msg.content,
        updatedAt: new Date(msg.updatedAt ?? Date.now()),
        edited: true,
      })
    })

    ctx.setInterval(async () => {
      const task = queue.shift()
      if (!task) return
      const bot = ctx.bots.find((bot) => bot.selfId === task.selfId)
      if (!bot) {
        logger.warn('Channel "%s" message sync task failed. Maybe bot offline.', task.channelId)
        return
      }

      const { data, next } = await bot.getMessageList(task.channelId, task.next)
      const sorted = data
        .map(m => {
          if (!m.createdAt && m.timestamp) m.createdAt = m.timestamp
          return m
        })
        .sort((a, b) => b.createdAt - a.createdAt)
      const finalIndex = sorted.findIndex(m => m.id === task.final)
      const messages = finalIndex === -1 ? sorted : sorted.slice(0, finalIndex)

      await upsert(messages.map(m => ({
        content: m.content,
        id: m.id,
        platform: bot.platform,
        'channel.id': task.channelId,
        'guild.id': task.guildId,
        quoteId: m.quote?.id,
        createdAt: new Date(m.timestamp ?? Date.now()),
        updatedAt: new Date(m.updatedAt ?? Date.now()),
        edited: m.updatedAt ? m.createdAt !== m.updatedAt : false,
        'user.id': m.user.id,
        'user.avatar': m?.member?.avatar || m?.user?.avatar,
        'user.name': m?.member?.name || m?.user?.name,
        'user.nick': m?.member?.nick || m?.user?.nick,
      })))

      if (finalIndex < 1) {
        task.next = next
        queue.push(task)
      } else {
        logger.debug('Channel "%s" message sync complete successfully.', task.channelId)
      }
    }, config.fetchInterval)
  }
}

namespace AppDatabase {
  export interface Config {
    fetchInterval: number
  }
  export const inject = ['database']
  export const Config: Schema<Config> = Schema.object({
    fetchInterval: Schema.number().default(50).description('获取历史消息的时间间隔'),
  })
}

export default AppDatabase
