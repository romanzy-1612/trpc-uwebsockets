# trpc-uwebsockets

[uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) adapter for [tRPC](https://trpc.io/)

# Installation


Yarn
```bash
yarn add trpc-uwebsockets
```
Npm
```bash
npm i trpc-uwebsockets
```

# Usage

Import needed packages

```typescript
import { App } from 'uWebSockets.js';
import { inferAsyncReturnType, initTRPC } from '@trpc/server';
import { CreateContextOptions } from 'trpc-uwebsockets';
import z from 'zod';
```

Define tRPC, context, and router

```typescript
const t = initTRPC.context<Context>().create();

const createContext = ({ req, res }: CreateContextOptions) => {
  const getUser = () => {
    if (req.headers.authorization === 'meow') {
      return {
        name: 'KATT',
      };
    }
    return null;
  };
  return {
    req,
    res,
    user: getUser(),
  };
};
export type Context = inferAsyncReturnType<typeof createContext>;

const router = t.router({
  hello: t.procedure
    .input(
      z
        .object({
          who: z.string().nullish(),
        })
        .nullish()
    )
    .query(({ input, ctx }) => {
      return {
        text: `hello ${input?.who ?? ctx.user?.name ?? 'world'}`,
      };
    }),
});
```

Initialize uWebsockets server and attach tRPC router

```typescript
const app = App();

createUWebSocketsHandler(app, '/trpc', {
  router,
  createContext,
});

/* dont crash on unknown request */
app.any('/*', (res) => {
  res.writeStatus('404 NOT FOUND');
  res.end();
});

app.listen('0.0.0.0', 8000, () => {
  console.log('Server listening on http://localhost:8000');
});
```

# API

Create context options

```typescript
type CreateContextOptions = {
  /* read-only request information */
  req: {
    headers: Record<string, string>;
    method: 'POST' | 'GET';
    query: string;
    path: string;
  };
  /* see https://unetworking.github.io/uWebSockets.js/generated/interfaces/HttpResponse.html */
  res: {
    writeStatus(status: RecognizedString) : HttpResponse;
    writeHeader(key: RecognizedString, value: RecognizedString) : HttpResponse;
  }
};
```

# Todo

- [ ] Various improvements (res.tryEnd + reading multiple headers /w same key)
- [ ] Subscription support with websockets
