# testissues

random repo for testing github issues, actions, builds and bot stuff.

there is also a build chat action in `build-chat/` that can send build results
to slack and maybe do some azure devops things.

## setup

```sh
npm install
```

## test

```sh
npm test
```

it prints some messages. set `fail=true` if you want it to fail:

```sh
fail=true npm test
```

## other stuff

most of the config is in `.github/`. some of it might be old. use at your own
risk.
