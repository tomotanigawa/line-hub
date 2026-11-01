#!/bin/sh
# クリップボードの鍵を ~/.credentials/<名前>.txt に保存する（鍵を画面やチャットに出さないため）
#   sh hub/savekey.sh <名前>
name=$1
v=$(pbpaste | tr -d '\r\n ')
case "$v" in
  '' | *pbpaste* | *savekey* | *'~/'* )
    echo "クリップボードの中身が鍵ではありません。ブラウザで「コピー」を押し直してから、もう一度実行してください"
    exit 1 ;;
esac
umask 077
printf '%s' "$v" > "$HOME/.credentials/$name.txt"
echo "保存しました（${#v}文字）"
