import pytest

async def test_list_users_requires_admin(user_client):
    resp = await user_client.get("/api/admin/users")
    assert resp.status_code == 403


async def test_list_users_requires_auth(client):
    resp = await client.get("/api/admin/users")
    assert resp.status_code == 401


async def test_admin_can_list_users(admin_client):
    resp = await admin_client.get("/api/admin/users")
    assert resp.status_code == 200
    usernames = {u["username"] for u in resp.json()}
    assert "admin" in usernames


async def test_admin_can_create_user(admin_client):
    resp = await admin_client.post(
        "/api/admin/users",
        json={"username": "bob", "display_name": "Bob", "initial_password": "bobpass123"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["username"] == "bob"
    assert "password_hash" not in body


async def test_created_user_can_login(admin_client, client):
    resp = await admin_client.post(
        "/api/admin/users",
        json={"username": "carol", "display_name": "Carol", "initial_password": "carolpass123"},
    )
    assert resp.status_code == 201

    resp = await client.post("/api/login", json={"username": "carol", "password": "carolpass123"})
    assert resp.status_code == 200


async def test_create_user_duplicate_username_conflicts(admin_client):
    resp = await admin_client.post(
        "/api/admin/users",
        json={"username": "dave", "display_name": "Dave", "initial_password": "davepass123"},
    )
    assert resp.status_code == 201

    resp = await admin_client.post(
        "/api/admin/users",
        json={"username": "dave", "display_name": "Dave 2", "initial_password": "other123"},
    )
    assert resp.status_code == 409


async def test_admin_can_deactivate_user(admin_client, client, normal_user):
    resp = await admin_client.delete(f"/api/admin/users/{normal_user.id}")
    assert resp.status_code == 200
    assert resp.json()["is_active"] is False

    resp = await client.post("/api/login", json={"username": "alice", "password": "alicepass123"})
    assert resp.status_code == 401


async def test_admin_can_toggle_admin_flag(admin_client, normal_user):
    resp = await admin_client.patch(f"/api/admin/users/{normal_user.id}", json={"is_admin": True})
    assert resp.status_code == 200
    assert resp.json()["is_admin"] is True


async def test_admin_can_reset_password(admin_client, client, normal_user):
    resp = await admin_client.patch(
        f"/api/admin/users/{normal_user.id}", json={"new_password": "newpass456"}
    )
    assert resp.status_code == 200

    resp = await client.post("/api/login", json={"username": "alice", "password": "newpass456"})
    assert resp.status_code == 200


@pytest.mark.parametrize(
    "body",
    [
        {"username": "  ", "display_name": "X", "initial_password": "longenough1"},
        {"username": "u" * 65, "display_name": "X", "initial_password": "longenough1"},
        {"username": "zed", "display_name": "   ", "initial_password": "longenough1"},
        {"username": "zed", "display_name": "d" * 101, "initial_password": "longenough1"},
        {"username": "zed", "display_name": "Zed", "initial_password": "short"},
        {"username": "zed", "display_name": "Zed", "initial_password": "p" * 257},
    ],
)
async def test_create_user_validation_422(admin_client, body):
    assert (await admin_client.post("/api/admin/users", json=body)).status_code == 422


async def test_create_user_strips_fields(admin_client):
    resp = await admin_client.post(
        "/api/admin/users",
        json={"username": "  zed  ", "display_name": " Zed ", "initial_password": "longenough1"},
    )
    assert resp.status_code == 201
    assert resp.json()["username"] == "zed" and resp.json()["display_name"] == "Zed"


async def test_update_user_validation_422(admin_client, normal_user):
    url = f"/api/admin/users/{normal_user.id}"
    assert (await admin_client.patch(url, json={"display_name": "  "})).status_code == 422
    assert (await admin_client.patch(url, json={"new_password": "short"})).status_code == 422
