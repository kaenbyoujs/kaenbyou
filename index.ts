import { Context } from 'cordis'
import SQLite from '@minatojs/driver-sqlite'
import Database from 'minato'
import MessageService from '@kaenbyoujs/database'

const ctx = new Context()
ctx.plugin(Database)
ctx.plugin(SQLite)
ctx.plugin(MessageService)

await ctx.start()
