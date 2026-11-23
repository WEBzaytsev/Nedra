import tempfile
import unittest
from pathlib import Path

from mcp.server.auth.middleware.auth_context import auth_context_var
from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser
from mcp.server.auth.provider import AccessToken
from sqlalchemy import func, select

from crud.access import AuthorizedPasswordCRUD
from crud.auth import AuthContext, AuthCRUD
from crud.engine import Database
from crud.folder import FolderCRUD, GroupCRUD
from errors import Forbidden
from mcp_server import MCP_SCOPE, build_mcp_server
from models import EntryAccessModel, EntryModel, FolderModel, UserModel
from schemas import (
    EntryPermission,
    EntryRef,
    Password,
    ServiceOperation,
    SharePermission,
    UserRole,
)
from vault_sessions import VaultSessions


class McpCreateEntryTests(unittest.IsolatedAsyncioTestCase):
    admin_password = "test-only-admin-password"
    member_password = "test-only-member-password"

    async def asyncSetUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.database = Database(Path(self.tmpdir.name))
        await self.database.prepare()
        self.sessions = VaultSessions(idle_timeout_ms=60_000)

        async with self.database.transaction() as session:
            auth = AuthCRUD(session, self.sessions, self.database)
            bootstrap = await auth.bootstrap("admin", self.admin_password)
            assert bootstrap.session_token is not None
            admin = await auth.context(bootstrap.session_token)
            member = await auth.create_user(
                admin,
                username="member",
                role=UserRole.member,
                temporary_password=self.member_password,
                current_password=None,
            )
            service = await auth.create_user(
                admin,
                username="mcp-service",
                role=UserRole.service,
                temporary_password=None,
                current_password=self.admin_password,
            )
            await auth.update_service_operations(
                admin,
                service.id,
                [ServiceOperation.create, ServiceOperation.update],
                self.admin_password,
            )

        self.member_id = member.id
        self.service_id = service.id
        assert service.service_token is not None
        self.service_token = service.service_token
        self.admin = await self._login("admin", self.admin_password)
        async with self.database.transaction(write=False) as session:
            member_model = await session.get(UserModel, self.member_id)
        assert member_model is not None
        self.member = AuthContext(member_model, self.admin.key)

        self.owner_folder_id = await self._folder(self.admin, "owner-target", "write")
        self.shared_folder_id = await self._folder(
            self.member, "shared-target", "write"
        )
        await self._folder(self.member, "read-only-target", "read")
        await self._folder(self.admin, "ambiguous-target", "write")
        await self._folder(self.member, "ambiguous-target", "write")
        async with self.database.transaction() as session:
            groups = GroupCRUD(session, self.admin)
            group = await groups.create("service-folders", self.admin.key)
            await groups.add_member(group.id, self.service_id)
            self.group_writer_folder_id = await self._group_folder(
                groups, "group-write-target", group.id, "write"
            )
            self.group_reader_folder_id = await self._group_folder(
                groups, "group-read-target", group.id, "read"
            )
        self.server = build_mcp_server(self.database, self.sessions)

    async def asyncTearDown(self) -> None:
        await self.database.dispose()
        self.tmpdir.cleanup()

    async def _login(self, username: str, password: str) -> AuthContext:
        async with self.database.transaction() as session:
            auth = AuthCRUD(session, self.sessions, self.database)
            response = await auth.login(username, password)
            assert response.valid and response.session_token is not None
            return await auth.context(response.session_token)

    async def _folder(self, owner: AuthContext, name: str, permission: str) -> int:
        async with self.database.transaction() as session:
            folders = FolderCRUD(session, owner)
            folder = await folders.create(name, owner.key)
            await folders.set_user_grant(
                folder.id,
                self.service_id,
                SharePermission(permission),
                None,
            )
            return folder.id

    async def _group_folder(
        self, groups: GroupCRUD, name: str, group_id: int, permission: str
    ) -> int:
        folders = FolderCRUD(groups.session, self.admin)
        folder = await folders.create(name, self.admin.key)
        await folders.set_group_grant(
            folder.id, group_id, SharePermission(permission), None
        )
        return folder.id

    @staticmethod
    def _entry(name: str, **values: object) -> dict[str, object]:
        entry: dict[str, object] = {
            "password_name": name,
            "password_value": "test-only-entry-secret",
            "username": "test-user",
            "totp_secret": "JBSWY3DPEHPK3PXP",
            "custom_fields": [{"label": "private", "value": "secret"}],
        }
        entry.update(values)
        return entry

    async def _call_tool(
        self, tool: str, arguments: dict[str, object]
    ) -> dict[str, object]:
        token = auth_context_var.set(
            AuthenticatedUser(
                AccessToken(
                    token=self.service_token,
                    client_id=f"nedra-service-{self.service_id}",
                    subject=str(self.service_id),
                    scopes=[MCP_SCOPE],
                    claims={},
                )
            )
        )
        try:
            result = await self.server.call_tool(tool, arguments)
        finally:
            auth_context_var.reset(token)
        payload = result.model_dump(mode="json")
        if payload.get("isError"):
            text = " ".join(item.get("text", "") for item in payload.get("content", []))
            raise RuntimeError(text or f"MCP {tool} returned an error")
        response = payload.get("structured_content")
        if not isinstance(response, dict):
            raise AssertionError(
                f"MCP {tool} returned no structured metadata: {payload}"
            )
        return response

    async def _call(self, entry: dict[str, object]) -> dict[str, object]:
        return await self._call_tool("create_entry", {"entry": entry})

    async def _error(self, entry: dict[str, object]) -> str:
        try:
            await self._call(entry)
        except Exception as error:
            return str(error).lower()
        self.fail("create_entry unexpectedly succeeded")

    async def _tool_error(self, tool: str, arguments: dict[str, object]) -> str:
        try:
            await self._call_tool(tool, arguments)
        except Exception as error:
            return str(error).lower()
        self.fail(f"{tool} unexpectedly succeeded")

    async def _entry_model(self, name: str) -> EntryModel | None:
        async with self.database.transaction(write=False) as session:
            return await session.scalar(
                select(EntryModel).where(
                    EntryModel.name_index == self.admin.key.name_index(name),
                    EntryModel.deleted.is_(None),
                )
            )

    async def _counts(self) -> tuple[int, int, int]:
        async with self.database.transaction(write=False) as session:
            return (
                (
                    await session.execute(select(func.count()).select_from(FolderModel))
                ).scalar_one(),
                (
                    await session.execute(select(func.count()).select_from(EntryModel))
                ).scalar_one(),
                (
                    await session.execute(
                        select(func.count())
                        .select_from(EntryAccessModel)
                        .where(EntryAccessModel.user_id == self.service_id)
                    )
                ).scalar_one(),
            )

    def _assert_redacted(self, metadata: dict[str, object]) -> None:
        self.assertFalse(
            {"password_value", "totp_secret", "custom_fields", "password_history"}
            & metadata.keys()
        )

    async def test_root_and_folder_id_creates_round_trip_with_redacted_metadata(
        self,
    ) -> None:
        root = await self._call(self._entry("root-entry"))
        self._assert_redacted(root)
        self.assertEqual(root["folder"], None)
        self.assertEqual(root["access"], EntryPermission.write.value)
        root_model = await self._entry_model("root-entry")
        assert root_model is not None
        self.assertIsNone(root_model.folder_id)

        by_id = await self._call(
            self._entry("folder-id-entry", folder_id=self.shared_folder_id)
        )
        self._assert_redacted(by_id)
        self.assertEqual(by_id["folder_id"], self.shared_folder_id)
        self.assertEqual(by_id["folder"], "shared-target")
        self.assertEqual(by_id["owner"], "member")
        by_id_model = await self._entry_model("folder-id-entry")
        assert by_id_model is not None
        self.assertEqual(by_id_model.folder_id, self.shared_folder_id)
        self.assertEqual(by_id_model.owner_id, self.member_id)

    async def test_unique_permitted_folder_names_create_in_the_existing_folder(
        self,
    ) -> None:
        for name, folder_id, owner in (
            ("owner-folder-name", self.owner_folder_id, "admin"),
            ("shared-folder-name", self.shared_folder_id, "member"),
            ("group-folder-name", self.group_writer_folder_id, "admin"),
        ):
            with self.subTest(name=name):
                folder = {
                    "owner-folder-name": "owner-target",
                    "shared-folder-name": "shared-target",
                    "group-folder-name": "group-write-target",
                }[name]
                metadata = await self._call(self._entry(name, folder=folder))
                self._assert_redacted(metadata)
                self.assertEqual(metadata["folder_id"], folder_id)
                self.assertEqual(metadata["owner"], owner)
                model = await self._entry_model(name)
                assert model is not None
                self.assertEqual(model.folder_id, folder_id)

    async def test_update_returns_client_error_for_unknown_folder_without_writes(
        self,
    ) -> None:
        created = await self._call(
            self._entry("update-entry", folder="group-write-target")
        )
        updated = await self._call_tool(
            "update_entry",
            {"entry_id": created["id"], "changes": {"username": "updated-user"}},
        )
        self.assertEqual(updated["folder_id"], self.group_writer_folder_id)

        before = await self._counts()
        error = await self._tool_error(
            "update_entry",
            {"entry_id": created["id"], "changes": {"folder": "missing-target"}},
        )
        self.assertIn("folder", error)
        self.assertEqual(await self._counts(), before)
        model = await self._entry_model("update-entry")
        assert model is not None
        self.assertEqual(model.folder_id, self.group_writer_folder_id)

    async def test_direct_entry_writer_can_edit_inside_a_read_only_folder(self) -> None:
        async with self.database.transaction() as session:
            crud = AuthorizedPasswordCRUD(session, self.admin)
            password = Password.model_validate(
                self._entry("direct-writer", folder_id=self.group_reader_folder_id)
            )
            await crud.create_password(password, self.admin.key)
            response = await crud.get_password("direct-writer", self.admin.key)
            await crud.acl.set_share(
                response.id, self.service_id, SharePermission.write
            )
        updated = await self._call_tool(
            "update_entry", {"entry_id": response.id, "changes": {"username": "edited"}}
        )
        self.assertEqual(updated["folder_id"], self.group_reader_folder_id)
        async with self.database.transaction(write=False) as session:
            stored = await AuthorizedPasswordCRUD(session, self.admin).get_password(
                "direct-writer", self.admin.key
            )
            self.assertEqual(stored.username, "edited")
            self.assertEqual(stored.custom_fields[0].value, "secret")

    async def test_bulk_move_uses_group_write_and_denies_group_read_atomically(
        self,
    ) -> None:
        created = await self._call(self._entry("bulk-root"))
        entry_id = created["id"]
        assert isinstance(entry_id, int)
        async with self.database.transaction() as session:
            service = await session.get(UserModel, self.service_id)
            assert service is not None
            crud = AuthorizedPasswordCRUD(session, AuthContext(service, self.admin.key))
            moved = await crud.move_passwords(
                [EntryRef(entry_id=entry_id)],
                self.group_writer_folder_id,
                self.admin.key,
            )
            self.assertEqual(moved.count, 1)

        model = await self._entry_model("bulk-root")
        assert model is not None
        self.assertEqual(model.folder_id, self.group_writer_folder_id)
        async with self.database.transaction() as session:
            service = await session.get(UserModel, self.service_id)
            assert service is not None
            crud = AuthorizedPasswordCRUD(session, AuthContext(service, self.admin.key))
            with self.assertRaisesRegex(Forbidden, "Write access"):
                await crud.move_passwords(
                    [EntryRef(entry_id=model.id)],
                    self.group_reader_folder_id,
                    self.admin.key,
                )

        unchanged = await self._entry_model("bulk-root")
        assert unchanged is not None
        self.assertEqual(unchanged.folder_id, self.group_writer_folder_id)

    async def test_human_named_folder_still_creates_a_personal_folder(self) -> None:
        async with self.database.transaction() as session:
            crud = AuthorizedPasswordCRUD(session, self.member)
            await crud.create_password(
                Password.model_validate(
                    self._entry("personal-folder-entry", folder="personal-target")
                ),
                self.member.key,
            )

        model = await self._entry_model("personal-folder-entry")
        assert model is not None and model.folder_id is not None
        async with self.database.transaction(write=False) as session:
            folder = await session.get(FolderModel, model.folder_id)
        assert folder is not None
        self.assertEqual(folder.owner_id, self.member_id)

    async def test_unknown_read_only_and_ambiguous_names_reject_without_writes(
        self,
    ) -> None:
        for name, folder, hint in (
            ("unknown-folder-name", "missing-target", "folder"),
            ("read-only-folder-name", "read-only-target", "writ"),
            ("group-read-only-folder-name", "group-read-target", "writ"),
            ("ambiguous-folder-name", "ambiguous-target", "folder_id"),
        ):
            with self.subTest(name=name):
                before = await self._counts()
                error = await self._error(self._entry(name, folder=folder))
                self.assertIn(hint, error)
                self.assertEqual(await self._counts(), before)
                self.assertIsNone(await self._entry_model(name))


if __name__ == "__main__":
    unittest.main()
