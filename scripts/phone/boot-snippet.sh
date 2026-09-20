#!/data/data/com.termux/files/usr/bin/sh
# Add this to the phone's existing ~/.termux/boot/start-vm.sh, do NOT create a second boot file.
#
# Termux:Boot runs EVERY executable in ~/.termux/boot/, so a stray extra file there starts a
# service nobody remembers adding. The home-lab-dashboard notes record exactly that happening:
# a leftover start-vm.sh.pre-adguard brought an old 4 GB VM back on every boot.
#
# The `=finance` target is deliberate. A tmux target with no exact match falls back to a prefix
# match, so `-t finance` could kill a different session.

tmux new-session -d -s finance 'sh ~/finance/app/scripts/phone/finance.sh'

# Check it:   tmux attach -t =finance
# Restart it: tmux kill-session -t =finance && tmux new-session -d -s finance 'sh ~/finance/app/scripts/phone/finance.sh'
