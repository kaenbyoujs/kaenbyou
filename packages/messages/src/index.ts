import { Context, Service } from '@satorijs/core'
import { MaybeArray, makeArray } from 'cosmokit'
import { $, Update } from '@kaenbyoujs/database-core'
import {} from '@kaenbyoujs/cordis-plugin-timer'
import Schema from 'schemastery'

declare module 'cordis' {
  interface Context {
    messages: MessageService
  }
}

declare module '@kaenbyoujs/database-core' {
  interface Tables {
    '@kaenbyoujs/messages@v1': Messages
  }
}

interface Messages {
  id: number
  content: string
  messageId: string
  platform: string
  createdAt: Date
  channelId: string
  guildId: string,
  quoteId?: string
  updatedAt?: Date
  deleted?: boolean
  edited?: boolean
  user: {
    userId: string
    username: string
    avatar?: string
    nickname?: string
  }
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
    const queue = ctx.createQueue<Task>(async (task) => {
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
        channelId: task.channelId,
        guildId: task.guildId,
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

    const upsert = async (msg: MaybeArray<Update<Messages>>) => {
      const messages = makeArray(msg)
      await ctx.database.upsert('@kaenbyoujs/messages@v1', messages, ['channelId', 'messageId', 'platform', 'guildId'])
    }

    const getFinalMessages = async (platform: string, guildId: string, selfId: string): Promise<Task[]> => {
      const a = await ctx.database.select('@kaenbyoujs/messages@v1')
        .where({ platform, guildId })
        .groupBy(['channelId', 'guildId'], { time: row => $.max(row.createdAt), final: 'messageId' })
        .execute()
        .then(data => data.map(data => ({ ...data, selfId })))
      return a
    }

    ctx.database.extend('@kaenbyoujs/messages@v1', {
      id: {
        type: 'unsigned',
        length: 8,
      },
      content: 'text',
      messageId: 'string',
      platform: 'string',
      createdAt: 'timestamp',
      quoteId: 'string',
      channelId: 'string',
      guildId: 'string',
      updatedAt: 'timestamp',
      deleted: {
        type: 'boolean',
        initial: false,
      },
      edited: {
        type: 'boolean',
        initial: false,
      },
      'user.userId': 'string',
      'user.avatar': 'string',
      'user.username': 'string',
      'user.nickname': 'string',
    }, {
      autoInc: true,
      primary: 'id',
    })

    ctx.on('bot-status-updated', async bot => {
      const guilds: Promise<Task[]>[] = []
      const support = await bot.supports('guild.list') && await bot.supports('message.list')
      if (!support) return
      for await (const guild of bot.getGuildIter()) {
        guilds.push(getFinalMessages(bot.platform, guild.id, bot.selfId))
      }

      queue.push(...await Promise.all(guilds).then(i => i.flat()))
    })

    ctx.on('guild-added', async ({ platform, guildId, bot }) => {
      queue.push(...await getFinalMessages(platform, guildId, bot.selfId))
    })

    ctx.on('message', async session => {
      const { content, messageId, platform, guildId, channelId } = session
      const { createdAt, updatedAt } = session.event?.message ?? {}
      const { user } = session.event
      await upsert({
        content,
        messageId,
        platform,
        channelId,
        guildId,
        edited: updatedAt ? createdAt !== updatedAt : false,
        quoteId: session.quote?.id,
        createdAt: new Date(createdAt ?? Date.now()),
        updatedAt: new Date(createdAt ?? Date.now()),
        'user.userId': user.id,
        'user.avatar': user.avatar,
        'user.username': user.name,
        'user.nickname': user.nick,
      })
    })

    ctx.on('message-deleted', async session => {
      const msg = session.event.message
      await ctx.database.set('@kaenbyoujs/messages@v1', { messageId: msg.id, channelId: session.channelId, platform: session.platform }, {
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
  }
}

namespace MessageService {
  export interface Config {
    fetchInterval: number
  }
  export const inject = ['database']
  export const Config: Schema<Config> = Schema.object({
    fetchInterval: Schema.number().default(50).description('获取历史消息的时间间隔')
  })
}

export default MessageService
