"""
HTTP API экспорта.

  GET /api/export/conversations/{id}?format=md|json  — один диалог
  GET /api/export/all                                — все диалоги архивом (Markdown + JSON)
"""

import io
import json
import zipfile
from datetime import datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ..chat import repository as chat_repo
from . import formats

router = APIRouter(prefix="/api/export", tags=["export"])


@router.get("/conversations/{conv_id}")
def export_conversation(conv_id: str, format: str = "md"):
    conv = chat_repo.get_conversation(conv_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Диалог не найден")
    messages = chat_repo.list_messages(conv_id)
    name = formats.safe_filename(conv["title"], conv["created_at"])
    if format == "md":
        body, media, ext = formats.to_markdown(conv, messages), "text/markdown; charset=utf-8", "md"
    elif format == "json":
        body, media, ext = formats.to_json_text(conv, messages), "application/json; charset=utf-8", "json"
    else:
        raise HTTPException(status_code=422, detail="Формат: md или json")
    return Response(body, media_type=media, headers={"Content-Disposition": formats.content_disposition(f"{name}.{ext}")})


@router.get("/all")
def export_all():
    """Архив: папка markdown/ с диалогами для чтения + conversations.json со всеми данными."""
    conversations = chat_repo.list_conversations()
    buffer = io.BytesIO()
    used: set[str] = set()
    full = []
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        for item in conversations:
            conv = chat_repo.get_conversation(item["id"])
            messages = chat_repo.list_messages(item["id"])
            name = formats.safe_filename(conv["title"], conv["created_at"])
            unique, n = name, 2
            while unique in used:  # одинаковые названия в один день — добавляем номер
                unique, n = f"{name} ({n})", n + 1
            used.add(unique)
            z.writestr(f"markdown/{unique}.md", formats.to_markdown(conv, messages))
            full.append(formats.to_json(conv, messages))
        z.writestr("conversations.json", json.dumps(full, ensure_ascii=False, indent=2))
    stamp = datetime.now().strftime("%Y-%m-%d")
    return Response(buffer.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": formats.content_disposition(f"Джарвис — диалоги {stamp}.zip")})
