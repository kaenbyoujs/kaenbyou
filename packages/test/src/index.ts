import { Context } from '@satorijs/core'
import SQLite from '@minatojs/driver-sqlite'
import Database from 'minato'
import AppDatabase from '@kaenbyoujs/database'
import * as AppServer from '@kaenbyoujs/app-server'
import 'dotenv/config'
import Discord from '@satorijs/adapter-discord'
import Server from '@cordisjs/server'

// temporary solution because upstream issue
;(AppDatabase as any).inject = ['model']
;(AppServer as any).inject = ['server', 'http', 'appdb', 'model']

const ctx = new Context()
ctx.plugin(Discord, {
  token: process.env.DISCORD_TOKEN,
  slash: false,
})
ctx.plugin(Database)
ctx.plugin(SQLite, {
  path: './test.db'
})
ctx.plugin(Server, {
  host: '0.0.0.0',
  port: 3453
})

;(async () => {
  await ctx.start()
  ctx.plugin(AppDatabase)
  ctx.plugin(AppServer)
})()
