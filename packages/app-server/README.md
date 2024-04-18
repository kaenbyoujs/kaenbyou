## Satori APP Server spec v0.1

### Compatibility 
- Extends Satori Protocol

### message.list
- Path: `/v1/app/message.list`
- Params:
```ts
type MessageListParams = {
  channel_id: string
  next?: string
}
```
- Returns
```ts
type Message = {
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
}[]
```

### contact.list
- Path: `/v1/app/contact.list`
- Params:
```ts
type ContactParams = {}
```
- Returns
```ts
type Contact = {
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
}[]
```

### login

- Path: `/v1/app/login`
- Params:
```ts
type LoginParams = {
  config: any
  platform: string
}
```
- Returns
```ts
type Login = Universal.Login

// Universal from satori
namespace Universal {
    interface Login {
        user?: User;
        platform?: string;
        selfId?: string;
        hidden?: boolean;
        status: Status;
    }

    interface User {
        id: string;
        name?: string;
        nick?: string;
        /** @deprecated */
        userId?: string;
        /** @deprecated */
        username?: string;
        /** @deprecated */
        nickname?: string;
        avatar?: string;
        discriminator?: string;
        isBot?: boolean;
    }

    const enum Status {
        OFFLINE = 0,
        ONLINE = 1,
        CONNECT = 2,
        DISCONNECT = 3,
        RECONNECT = 4
    }
}
```
