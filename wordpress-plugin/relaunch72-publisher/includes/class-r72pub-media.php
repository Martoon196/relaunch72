<?php
/**
 * Featured image import from validated sources only.
 *
 * - The URL must start with an administrator-approved https prefix (default: Relaunch72's
 *   released article media path). No credentials, query strings, fragments or ports.
 * - Fetched with wp_safe_remote_get (rejects private/loopback addresses) and redirects off.
 * - At most 10 MB; must decode as JPEG, PNG or WebP.
 * - Relaunch72 release URLs end in the image's SHA-256; the bytes must match it.
 * - One attachment per (article, source URL): retries and repeated versions reuse it.
 *
 * @package Relaunch72Publisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class R72Pub_Media {
	const MAX_BYTES  = 10485760;
	const META_SRC   = '_r72_source_sha';
	const META_OWNER = '_r72_article_id';

	/** @return true|WP_Error */
	public static function validate_url( $url ) {
		if ( ! is_string( $url ) || strlen( $url ) > 2048 ) {
			return new WP_Error( 'r72_media_url', 'The featured image address is invalid. Nothing was changed.', array( 'status' => 409 ) );
		}
		$p = wp_parse_url( $url );
		if ( ! is_array( $p ) || ( $p['scheme'] ?? '' ) !== 'https' || isset( $p['user'] ) || isset( $p['pass'] ) || isset( $p['port'] ) || isset( $p['query'] ) || isset( $p['fragment'] ) || false !== strpos( (string) ( $p['path'] ?? '' ), '..' ) ) {
			return new WP_Error( 'r72_media_url', 'The featured image must be a plain https address. Nothing was changed.', array( 'status' => 409 ) );
		}
		foreach ( R72Pub_Settings::get()['media_prefixes'] as $prefix ) {
			if ( 0 === strpos( $url, $prefix ) ) {
				return true;
			}
		}
		return new WP_Error( 'r72_media_source', 'The featured image is not from an approved media source for this site. Add the source in Relaunch72 → Connection if it is trusted. Nothing was changed.', array( 'status' => 409 ) );
	}

	/**
	 * @return int|WP_Error attachment ID. WP_Error status 503 means "try again later" (nothing created).
	 */
	public static function import( $url, $alt, $article_id, $post_id = 0 ) {
		$ok = self::validate_url( $url );
		if ( is_wp_error( $ok ) ) {
			return $ok;
		}
		$source_sha = hash( 'sha256', $url );
		$existing   = get_posts(
			array(
				'post_type'      => 'attachment',
				'post_status'    => 'any',
				'posts_per_page' => 1,
				'fields'         => 'ids',
				'meta_query'     => array(
					array( 'key' => self::META_SRC, 'value' => $source_sha ),
					array( 'key' => self::META_OWNER, 'value' => $article_id ),
				),
			)
		);
		if ( $existing ) {
			update_post_meta( (int) $existing[0], '_wp_attachment_image_alt', wp_slash( sanitize_text_field( $alt ) ) );
			return (int) $existing[0];
		}
		$response = wp_safe_remote_get(
			$url,
			array(
				'timeout'             => 15,
				'redirection'         => 0,
				'limit_response_size' => self::MAX_BYTES + 1,
				'user-agent'          => 'Relaunch72-Publisher/' . R72PUB_VERSION . '; ' . home_url( '/' ),
			)
		);
		if ( is_wp_error( $response ) ) {
			return new WP_Error( 'r72_media_unavailable', 'The featured image could not be downloaded yet. Nothing was published.', array( 'status' => 503 ) );
		}
		$code = (int) wp_remote_retrieve_response_code( $response );
		if ( $code >= 500 || 429 === $code || 408 === $code ) {
			return new WP_Error( 'r72_media_unavailable', 'The image server is temporarily unavailable. Nothing was published.', array( 'status' => 503 ) );
		}
		if ( 200 !== $code ) {
			return new WP_Error( 'r72_media_rejected', 'The featured image source answered HTTP ' . $code . ' (redirects are not followed). Nothing was published.', array( 'status' => 409 ) );
		}
		$bytes = (string) wp_remote_retrieve_body( $response );
		if ( '' === $bytes || strlen( $bytes ) > self::MAX_BYTES ) {
			return new WP_Error( 'r72_media_size', 'The featured image is empty or larger than 10 MB. Nothing was published.', array( 'status' => 409 ) );
		}
		if ( preg_match( '#/([0-9a-f]{64})\.(?:jpg|jpeg|png|webp)$#', (string) wp_parse_url( $url, PHP_URL_PATH ), $m ) && ! hash_equals( $m[1], hash( 'sha256', $bytes ) ) ) {
			return new WP_Error( 'r72_media_integrity', 'The downloaded image does not match the digest in its release address. Nothing was published.', array( 'status' => 409 ) );
		}
		$info = @getimagesizefromstring( $bytes ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- invalid input is reported below.
		$ext  = array( 'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp' );
		if ( ! is_array( $info ) || ! isset( $ext[ $info['mime'] ] ) ) {
			return new WP_Error( 'r72_media_type', 'The featured image must be a JPEG, PNG or WebP image. Nothing was published.', array( 'status' => 409 ) );
		}
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';
		$name   = 'r72-' . substr( $source_sha, 0, 16 ) . '.' . $ext[ $info['mime'] ];
		$upload = wp_upload_bits( $name, null, $bytes );
		if ( ! empty( $upload['error'] ) ) {
			return new WP_Error( 'r72_media_store', 'WordPress could not store the featured image (check uploads folder permissions). Nothing was published.', array( 'status' => 409 ) );
		}
		$attachment_id = wp_insert_attachment(
			array(
				'post_mime_type' => $info['mime'],
				'post_title'     => sanitize_text_field( $alt ? $alt : 'Article image' ),
				'post_status'    => 'inherit',
			),
			$upload['file'],
			$post_id,
			true
		);
		if ( is_wp_error( $attachment_id ) ) {
			wp_delete_file( $upload['file'] );
			return new WP_Error( 'r72_media_store', 'WordPress could not register the featured image. Nothing was published.', array( 'status' => 409 ) );
		}
		wp_update_attachment_metadata( $attachment_id, wp_generate_attachment_metadata( $attachment_id, $upload['file'] ) );
		update_post_meta( $attachment_id, '_wp_attachment_image_alt', wp_slash( sanitize_text_field( $alt ) ) );
		update_post_meta( $attachment_id, self::META_SRC, $source_sha );
		update_post_meta( $attachment_id, self::META_OWNER, $article_id );
		return (int) $attachment_id;
	}
}
