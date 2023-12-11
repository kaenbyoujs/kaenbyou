import { Context, Universal } from '@satorijs/core'
import { MaybeArray, makeArray } from 'cosmokit'
import { $ } from '@kaenbyoujs/database-core'
import {} from '@kaenbyoujs/cordis-plugin-timer'

declare module '@kaenbyoujs/database-core' {
  interface Tables {
    '@kaenbyoujs/messages@v1': {
      id: number
      content: string
      messageId: string
      platform: string
      userId: string
      avatar?: string
      createdAt: Date
      quoteId?: string
      username: string
      nickname: string
      channelId: string
      guildId: string,
      updatedAt?: Date
      deleted?: boolean
      edited?: boolean
    }
  }
}

export const inject = ['database', 'timer']

export function apply(ctx: Context) {
  async function fromMessages(msg: MaybeArray<Universal.Message>, platform: string) {
    const messages = makeArray(msg)
    
    await ctx.database.upsert('@kaenbyoujs/messages@v1', messages.map(m => ({
      content: m.content,
      messageId: m.id,
      platform,
      userId: m.user.id,
      avatar: m.user.avatar,
      createdAt: new Date(m.createdAt ?? Date.now()),
      quoteId: m.quote.id,
      username: m.user.name,
      nickname: m.user.nick,
      channelId: m.channel.id,
      guildId: m.guild.id,
      updatedAt: new Date(m.updatedAt ?? Date.now()),
      edited: m.createdAt !== m.updatedAt,
    })))
  }

  const queue: {
    channelId: string
    selfId: string
    final: string
    next?: string
  }[] = []
  
  ctx.database.extend('@kaenbyoujs/messages@v1', {
    id: {
      type: 'unsigned',
      length: 8,
    },
    content: 'text',
    messageId: 'string',
    platform: 'string',
    userId: 'string',
    avatar: 'string',
    createdAt: 'timestamp',
    quoteId: 'string',
    username: 'string',
    nickname: 'string',
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
  }, {
    autoInc: true,
    primary: 'id',
  })

  ctx.on('bot-status-updated', async bot => {
    const channelIds: string[] = []
    for await (const guild of bot.getGuildIter()) {
      for await (const channel of bot.getChannelIter(guild.id)) {
        channelIds.push(channel.id)
      }
    }

    const channels = await ctx.database.select('@kaenbyoujs/messages@v1')
      .where({ platform: bot.platform, channelId: { $in: channelIds } })
      // https://github.com/shigma/minato/issues/60
      // @ts-expect-error
      .groupBy(['channelId'], { time: row => $.max(row.createdAt), final: 'messageId' })
      .execute()
      .then(data => data.map(data => ({ ...data, selfId: bot.selfId })))

    queue.push(...channels)
  })

  ctx.on('guild-added', async ({ guildId, platform, bot }) => {
    const channels = await ctx.database.select('@kaenbyoujs/messages@v1')
      .where({ platform, guildId })
      // https://github.com/shigma/minato/issues/60
      // @ts-expect-error
      .groupBy(['channelId'], { time: row => $.max(row.createdAt), final: 'messageId' })
      .execute()
      .then(data => data.map(data => ({ ...data, selfId: bot.selfId })))

    queue.push(...channels)
  })

  ctx.on('message', async session => {
    await fromMessages(session.event.message, session.platform)
  })

  ctx.on('message-deleted', async session => {
    const msg = session.event.message
    await ctx.database.set('@kaenbyoujs/messages@v1', { messageId: msg.id, platform: session.platform }, {
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
    const data = queue.shift()
    const bot = ctx.bots.find((bot) => bot.selfId === data.selfId)

    const { data: messages, next } = await bot.getMessageList(data.channelId, data.next)
    const finalIndex = messages.findIndex(m => m.id === data.final)
    if (finalIndex !== -1) {
      await fromMessages(messages.slice(0, finalIndex), bot.platform)
      return
    }

    await fromMessages(messages, bot.platform)
    data.next = next
    queue.push(data)
  }, 1000)
}
