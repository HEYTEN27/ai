"""
HTTP API проектов.

  GET    /api/projects           — все проекты (с числом чатов и файлов)
  POST   /api/projects           — создать: {name, icon?, instructions?}
  GET    /api/projects/{id}      — проект, его чаты и файлы
  PATCH  /api/projects/{id}      — переименовать, поменять значок или инструкции
  DELETE /api/projects/{id}      — удалить (чаты остаются, файлы проекта удаляются)

Файлы в проект загружаются через POST /api/files с полем project_id.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..files import store as files_store
from . import repository as repo

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=repo.MAX_NAME)
    icon: str = Field(default="📁", max_length=8)
    instructions: str = Field(default="", max_length=repo.MAX_INSTRUCTIONS)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=repo.MAX_NAME)
    icon: str | None = Field(default=None, max_length=8)
    instructions: str | None = Field(default=None, max_length=repo.MAX_INSTRUCTIONS)


def _get_or_404(project_id: int) -> dict:
    project = repo.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    return project


def _call(fn):
    try:
        return fn()
    except repo.ProjectError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.get("")
def list_projects():
    return repo.list_projects()


@router.post("", status_code=201)
def create_project(body: ProjectCreate):
    return _call(lambda: repo.create_project(body.name, body.icon, body.instructions))


@router.get("/{project_id}")
def get_project(project_id: int):
    project = _get_or_404(project_id)
    return {**project, "conversations": repo.project_conversations(project_id),
            "files": files_store.project_files(project_id, with_text=False)}


@router.patch("/{project_id}")
def update_project(project_id: int, body: ProjectUpdate):
    _get_or_404(project_id)
    return _call(lambda: repo.update_project(project_id, name=body.name, icon=body.icon, instructions=body.instructions))


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int):
    if not repo.delete_project(project_id):
        raise HTTPException(status_code=404, detail="Проект не найден")
    files_store.cleanup()  # записи о файлах проекта удалились каскадом — убираем их с диска
