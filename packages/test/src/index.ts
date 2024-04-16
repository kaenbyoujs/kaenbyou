import { Context, Logger } from '@satorijs/core'
import SQLite from '@minatojs/driver-sqlite'
import Database from 'minato'
import AppDatabase from '@kaenbyoujs/database'
import * as AppServer from '@kaenbyoujs/app-server'
import Discord from '@satorijs/adapter-discord'
import Server from '@cordisjs/server'
import 'dotenv/config'

const logger = new Logger('tester')


const ctx = new Context()
ctx.plugin(Discord, {
  token: process.env.DISCORD_TOKEN,
})
ctx.plugin(Database)
ctx.plugin(SQLite, {
  path: './test.db'
})
ctx.plugin(Server, {
  host: '0.0.0.0',
  port: 3453
})
ctx.plugin(AppDatabase)
ctx.plugin(AppServer)

async function apply(ctx: Context) {
  // ctx.setInterval(async () => {
  //   const a = await ctx.database.get('@kaenbyoujs/messages@v1', {})
  //   console.log('%o', a)
  // }, 10000)
}
apply.inject = ['database']
ctx.plugin(apply)

;(async () => {
  await ctx.start()
  ctx.on('message', session => {
    logger.info('User: %s; Content: %s', session.event.user.nick || session.event.user.name, session.content)
  })
  // ctx.on('http/fetch-init', (url, init, config) => {
  //   logger.info('URL: %o', url)
  //   logger.info('init: %o', init)
  //   logger.info('config: %o', config)
  // })
})()

