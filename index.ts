import { Context } from '@satorijs/core'
import SQLite from '@minatojs/driver-sqlite'
import Database from 'minato'
import AppDatabase from '@kaenbyoujs/database'
import * as AppServer from '@kaenbyoujs/app-server'
import Discord from '@satorijs/adapter-discord'
import Server from '@cordisjs/server'

const ctx = new Context()
ctx.plugin(Discord, {
  // token
  token: '',
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
ctx.plugin(AppDatabase)
ctx.plugin(AppServer)

;(async () => {
  await ctx.start()
})()
