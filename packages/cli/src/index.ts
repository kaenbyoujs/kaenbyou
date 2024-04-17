import Server from '@cordisjs/server'
import * as AppServer from '@kaenbyoujs/app-server'
import AppDatabase from '@kaenbyoujs/database'
import SQLite from '@minatojs/driver-sqlite'
import { Context, Logger } from '@satorijs/core'
import Database from 'minato'
import 'dotenv/config'

const logger = new Logger('tester')

const ctx = new Context()
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

