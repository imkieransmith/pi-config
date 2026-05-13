# Pi config and extensions
This repo is my personal Pi coding agent setup. It’s a collection of custom extensions, tools, skills, and configuration I use day to day.

A number of the extensions originally started from work shared by other Pi users. Where that’s the case, I’ve linked back to the original extension in the relevant source file comments. From there I’ve usually tweaked, combined, or rewritten parts to better fit my own workflow, preferences, and local setup.

Most packages/extensions are copied into this repo and built on directly rather than pulled in as dependencies. That keeps everything self-contained, means I only have to properly audit the code once, lets me customise things freely, and avoids worrying about upstream changes or security surprises later.

The code here is intended as a working personal config rather than a polished package, but it may still be useful to you as a reference if you’re building or adapting your own Pi extensions.

## Install

```bash
pi install git:github.com/imkieransmith/pi-config
```

You can install it directly like this, but I'd recommend copying the parts you want into your own config and building on top of them instead. That’s how this repo evolved in the first place, and it makes it much easier to fully understand, customise, and maintain your own setup long term.

## License

MIT. Attribution for code that originally came from other Pi users is linked in the relevant source files where applicable.