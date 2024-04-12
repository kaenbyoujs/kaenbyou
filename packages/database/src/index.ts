import { Context, Service } from '@satorijs/core'
import { makeArray, MaybeArray } from 'cosmokit'
import { $, Update } from 'minato'
import {} from '@cordisjs/timer'
import Schema from 'schemastery'

declare module '@satorijs/core' {
  interface Context {
    messages: MessageService
  }
}

declare module 'minato' {
  namespace Database {
    interface Tables {
      '@kaenbyoujs/messages@v1': Message
    }
  }
}

export interface Message {
  id: number
  content: string
  messageId: string
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
  belong: number
  content: string
}

interface Task {
  channelId: string
  guildId: string
  selfId: string
  final: string
  next?: string
}

class MessageService extends Service {
  constructor(public ctx: Context, public config: MessageService.Config) {
    super(ctx, 'message')
    const queue: Task[] = []

    const upsert = async (msg: MaybeArray<Update<Message>>) => {
      const messages = makeArray(msg)
      await ctx.database.upsert('@kaenbyoujs/messages@v1', messages, ['channel.id', 'messageId', 'platform', 'guild.id'])
    }

    // const getFinalMessages = async (platform: string, guildId: string, selfId: string): Promise<Task[]> => {
    //   const a = 
    //   return a
    // }

    ctx.database.extend('@kaenbyoujs/messages@v1', {
      id: {
        type: 'unsigned',
        length: 8,
      },
      content: 'text',
      messageId: 'string',
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
      primary: 'id',
      // @ts-expect-error
      unique: [['platform', 'channel.id', 'messageId']],
    })

    ctx.on('bot-status-updated', async bot => {
      const support = await bot.supports('guild.list') && await bot.supports('message.list')
      if (!support) return
      for await (const guild of bot.getGuildIter()) {
        const last = await ctx.database.select('@kaenbyoujs/messages@v1')
        .where({ platform: bot.platform, 'guild.id': guild.id })
        // @ts-expect-error
        .groupBy(['channel.id', 'guild.id'], { time: row => $.max(row.createdAt), final: 'messageId' })
        .execute()
        
        // @ts-expect-error
        queue.push({ ...last, selfId: bot.selfId })
      }
    })

    ctx.on('message', async session => {
      const { content, messageId, platform, guildId, channelId } = session
      const { createdAt, updatedAt } = session.event?.message ?? {}
      const { user } = session.event
      await upsert({
        content,
        messageId,
        platform,
        'channel.id': channelId,
        'guild.id': guildId,
        edited: updatedAt ? createdAt !== updatedAt : false,
        quote: session.quote?.id,
        createdAt: new Date(createdAt ?? Date.now()),
        updatedAt: new Date(createdAt ?? Date.now()),
        'user.id': user.id,
        'user.avatar': user.avatar,
        'user.name': user.name,
        'user.nick': user.nick,
      })
    })

    ctx.on('message-deleted', async session => {
      const msg = session.event.message
      await ctx.database.set('@kaenbyoujs/messages@v1', { messageId: msg.id, 'channel.id': session.channelId, platform: session.platform }, {
        updatedAt: new Date(msg.updatedAt ?? Date.now()),
        deleted: true,
      })
    })

    ctx.on('message-updated', async session => {
      const msg = session.event.message
      await ctx.database.set('@kaenbyoujs/messages@v1', { messageId: msg.id, platform: session.platform }, {
        content: msg.content,
        updatedAt: new Date(msg.updatedAt ?? Date.now()),
        edited: true,
      })
    })

    ctx.setInterval(async () => {
      const task = queue.shift()
      const bot = ctx.bots.find((bot) => bot.selfId === task.selfId)
      if (!bot) {
        this.logger.warn('Channel "%s" message sync task failed. Maybe bot offline.', task.channelId)
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
      if (finalIndex === 0) return
      const messages = finalIndex === -1 ? sorted : sorted.slice(0, finalIndex)

      await upsert(messages.map(m => ({
        content: m.content,
        messageId: m.id,
        platform: bot.platform,
        'channel.id': task.channelId,
        'guild.id': task.guildId,
        quoteId: m.quote?.id,
        createdAt: new Date(m.timestamp ?? Date.now()),
        updatedAt: new Date(m.updatedAt ?? Date.now()),
        edited: m.updatedAt ? m.createdAt !== m.updatedAt : false,
        'user.userId': m.user.id,
        'user.avatar': m.user.avatar,
        'user.username': m.user.name,
        'user.nickname': m.user.nick,
      })))

      if (finalIndex === -1) {
        task.next = next
        queue.push(task)
      } else {
        this.logger.debug('Channel "%s" message sync complete successfully.', task.channelId)
      }
    }, config.fetchInterval)
  }
}

namespace MessageService {
  export interface Config {
    fetchInterval: number
  }
  export const inject = ['database']
  export const Config: Schema<Config> = Schema.object({
    fetchInterval: Schema.number().default(50).description('获取历史消息的时间间隔'),
  })
}

export default MessageService
