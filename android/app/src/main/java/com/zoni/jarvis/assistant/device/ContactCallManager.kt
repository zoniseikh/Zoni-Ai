package com.zoni.jarvis.assistant.device

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import com.zoni.jarvis.assistant.domain.NumberNormalizer
import com.zoni.jarvis.assistant.domain.NumberNormalizerResult

data class ContactMatch(
    val id: String,
    val displayName: String,
    val phoneNumbers: List<String>
)

sealed class ContactCallResolution {
    data class ReadyToCall(val name: String, val number: String, val useDirectCall: Boolean) : ContactCallResolution()
    data class MultipleMatches(val query: String, val candidates: List<ContactMatch>) : ContactCallResolution()
    data class MultipleNumbersForContact(val name: String, val numbers: List<String>) : ContactCallResolution()
    data class ContactNotFound(val query: String) : ContactCallResolution()
    object PermissionMissing : ContactCallResolution()
    data class CallFailed(val reason: String) : ContactCallResolution()
}

class ContactCallManager(private val context: Context) {

    fun hasContactPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.READ_CONTACTS
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun hasCallPhonePermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.CALL_PHONE
        ) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Resolves a contact name query against the Android Contacts Provider.
     */
    fun resolveContact(contactQuery: String): ContactCallResolution {
        if (!hasContactPermission()) {
            return ContactCallResolution.PermissionMissing
        }

        val cleanQuery = contactQuery.trim()
        if (cleanQuery.isBlank()) {
            return ContactCallResolution.ContactNotFound(cleanQuery)
        }

        val matches = mutableListOf<ContactMatch>()
        val uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI
        val projection = arrayOf(
            ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER
        )
        val selection = "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?"
        val selectionArgs = arrayOf("%$cleanQuery%")

        var cursor: Cursor? = null
        try {
            cursor = context.contentResolver.query(
                uri,
                projection,
                selection,
                selectionArgs,
                "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC"
            )

            if (cursor != null && cursor.moveToFirst()) {
                val tempMap = mutableMapOf<String, Pair<String, MutableList<String>>>()
                val idIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.CONTACT_ID)
                val nameIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                val numberIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)

                do {
                    val id = cursor.getString(idIndex)
                    val name = cursor.getString(nameIndex)
                    val rawNumber = cursor.getString(numberIndex)
                    val normResult = NumberNormalizer.normalizePhoneNumber(rawNumber)
                    val cleanNumber = if (normResult is NumberNormalizerResult.ValidCandidate) {
                        normResult.normalizedNumber
                    } else {
                        rawNumber.filter { it.isDigit() || it == '+' }
                    }

                    val existing = tempMap.getOrPut(id) { Pair(name, mutableListOf()) }
                    if (!existing.second.contains(cleanNumber)) {
                        existing.second.add(cleanNumber)
                    }
                } while (cursor.moveToNext())

                for ((id, pair) in tempMap) {
                    matches.add(ContactMatch(id, pair.first, pair.second))
                }
            }
        } catch (e: Exception) {
            return ContactCallResolution.CallFailed("Contacts provider query error: ${e.message}")
        } finally {
            cursor?.close()
        }

        if (matches.isEmpty()) {
            return ContactCallResolution.ContactNotFound(cleanQuery)
        }

        // Single contact match
        if (matches.size == 1) {
            val contact = matches[0]
            return if (contact.phoneNumbers.size == 1) {
                ContactCallResolution.ReadyToCall(
                    name = contact.displayName,
                    number = contact.phoneNumbers[0],
                    useDirectCall = hasCallPhonePermission()
                )
            } else {
                ContactCallResolution.MultipleNumbersForContact(contact.displayName, contact.phoneNumbers)
            }
        }

        // Multiple matching contacts (e.g. multiple "Rahul")
        return ContactCallResolution.MultipleMatches(cleanQuery, matches)
    }

    /**
     * Executes the phone call intent. Uses ACTION_CALL if CALL_PHONE is granted,
     * otherwise gracefully falls back to ACTION_DIAL.
     */
    fun initiateCall(phoneNumber: String): Boolean {
        val cleanNumber = phoneNumber.trim()
        if (cleanNumber.isBlank()) return false

        val intent = if (hasCallPhonePermission()) {
            Intent(Intent.ACTION_CALL, Uri.parse("tel:$cleanNumber"))
        } else {
            Intent(Intent.ACTION_DIAL, Uri.parse("tel:$cleanNumber"))
        }.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }

        return try {
            context.startActivity(intent)
            true
        } catch (e: Exception) {
            false
        }
    }
}
