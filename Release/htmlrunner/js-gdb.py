""" GDB Python customization auto-loader for js shell """

import os.path
sys.path[0:0] = [os.path.join('e:/hg38/comm-esr38/mozilla/js/src', 'gdb')]

import mozilla.autoload
mozilla.autoload.register(gdb.current_objfile())
