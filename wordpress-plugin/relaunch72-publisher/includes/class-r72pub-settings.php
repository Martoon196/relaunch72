<?php
/**
 * Options, the sealed connection key and a small secret-free audit trail.
 *
 * @package Relaunch72Publisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class R72Pub_Settings {
	const OPT_SITE_ID  = 'r72pub_site_id';
	const OPT_SECRET   = 'r72pub_secret';
	const OPT_PAIRING  = 'r72pub_pairing';
	const OPT_SETTINGS = 'r72pub_settings';
	const OPT_SITE_SEO = 'r72pub_site_seo';
	const OPT_AUDIT    = 'r72pub_audit';

	/** Default media source: Relaunch72's released, content-addressed article images only. */
	const DEFAULT_MEDIA_PREFIX = 'https://app.relaunch72.com/api/public/seo-blog/media/';

	public static function ensure_site_id() {
		$id = get_option( self::OPT_SITE_ID );
		if ( ! is_string( $id ) || ! self::is_uuid( $id ) ) {
			$id = wp_generate_uuid4();
			add_option( self::OPT_SITE_ID, $id, '', 'no' );
			$id = get_option( self::OPT_SITE_ID );
		}
		return $id;
	}

	public static function site_id() {
		return self::ensure_site_id();
	}

	public static function is_uuid( $value ) {
		return is_string( $value ) && 1 === preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $value );
	}

	public static function defaults() {
		return array(
			'paused'            => false,
			'author_id'         => 0,
			'media_prefixes'    => array( self::DEFAULT_MEDIA_PREFIX ),
			'create_categories' => true,
			'max_categories'    => 3,
			'seo_mode'          => 'auto',
		);
	}

	public static function get() {
		$stored = get_option( self::OPT_SETTINGS, array() );
		$stored = is_array( $stored ) ? $stored : array();
		$merged = array_merge( self::defaults(), $stored );
		$merged['paused']            = (bool) $merged['paused'];
		$merged['author_id']         = absint( $merged['author_id'] );
		$merged['create_categories'] = (bool) $merged['create_categories'];
		$merged['max_categories']    = max( 0, min( 5, (int) $merged['max_categories'] ) );
		$merged['seo_mode']          = in_array( $merged['seo_mode'], array( 'auto', 'content_only' ), true ) ? $merged['seo_mode'] : 'auto';
		$merged['media_prefixes']    = array_values( array_filter( (array) $merged['media_prefixes'], array( __CLASS__, 'valid_media_prefix' ) ) );
		return $merged;
	}

	public static function update( array $changes ) {
		$next = array_merge( self::get(), $changes );
		update_option( self::OPT_SETTINGS, $next, false );
		return self::get();
	}

	public static function paused() {
		$s = self::get();
		return ! empty( $s['paused'] );
	}

	/** A media prefix is an exact https origin plus a path ending in "/"; no credentials, query or fragment. */
	public static function valid_media_prefix( $prefix ) {
		if ( ! is_string( $prefix ) || strlen( $prefix ) > 300 ) {
			return false;
		}
		$p = wp_parse_url( $prefix );
		if ( ! is_array( $p ) || ( $p['scheme'] ?? '' ) !== 'https' || empty( $p['host'] ) || isset( $p['user'] ) || isset( $p['pass'] ) || isset( $p['query'] ) || isset( $p['fragment'] ) || isset( $p['port'] ) ) {
			return false;
		}
		$path = $p['path'] ?? '/';
		return '/' === substr( $path, -1 ) && false === strpos( $path, '..' );
	}

	// ─── Sealed connection key ──────────────────────────────────────────────

	private static function key() {
		return hash( 'sha256', wp_salt( 'auth' ) . '|r72pub-connection-key|' . self::site_id(), true );
	}

	public static function has_secret() {
		return '' !== self::secret();
	}

	/** Returns the plaintext key for signature verification only. Never echo, log or return it. */
	public static function secret() {
		$sealed = get_option( self::OPT_SECRET, '' );
		if ( ! is_string( $sealed ) || '' === $sealed ) {
			return '';
		}
		$raw = base64_decode( $sealed, true );
		if ( false === $raw || strlen( $raw ) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ) {
			return '';
		}
		$nonce  = substr( $raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$cipher = substr( $raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		try {
			$plain = sodium_crypto_secretbox_open( $cipher, $nonce, self::key() );
		} catch ( Exception $e ) {
			return '';
		}
		return is_string( $plain ) ? $plain : '';
	}

	/**
	 * Create a new connection key. Any previous key stops working immediately and the
	 * brand pairing is cleared, so the new key must be entered in Relaunch72's secure
	 * website setup and checked again. Published content is untouched.
	 */
	public static function rotate_secret() {
		$secret = 'r72wp_' . bin2hex( random_bytes( 32 ) );
		$nonce  = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$sealed = base64_encode( $nonce . sodium_crypto_secretbox( $secret, $nonce, self::key() ) );
		update_option( self::OPT_SECRET, $sealed, false );
		delete_option( self::OPT_PAIRING );
		self::audit( 'key.rotated', 'A new connection key was created; the previous key and brand pairing were revoked.' );
		return $secret;
	}

	/** Disconnect: removes the key and pairing only. Posts, media, categories and SEO values stay. */
	public static function disconnect() {
		delete_option( self::OPT_SECRET );
		delete_option( self::OPT_PAIRING );
		self::audit( 'connection.removed', 'Connection key and pairing removed. Published content was kept.' );
	}

	// ─── Brand pairing (first verified check binds brand + destination) ─────

	public static function pairing() {
		$p = get_option( self::OPT_PAIRING, array() );
		return is_array( $p ) ? $p : array();
	}

	/**
	 * Binds this site to exactly one Relaunch72 brand and destination on the first
	 * correctly signed connection check. A later request for a different brand or
	 * destination is refused until an administrator rotates the key.
	 *
	 * @return true|WP_Error
	 */
	public static function bind_pairing( $brand_id, $destination_id ) {
		if ( ! self::is_uuid( $brand_id ) || ! self::is_uuid( $destination_id ) ) {
			return new WP_Error( 'r72_pairing_required', 'The connection check must identify the Relaunch72 brand and website connection.', array( 'status' => 400 ) );
		}
		$p = self::pairing();
		if ( empty( $p['brandId'] ) ) {
			update_option(
				self::OPT_PAIRING,
				array(
					'brandId'       => strtolower( $brand_id ),
					'destinationId' => strtolower( $destination_id ),
					'pairedAt'      => gmdate( 'c' ),
					'lastCheckAt'   => gmdate( 'c' ),
				),
				false
			);
			self::audit( 'connection.paired', 'Paired to Relaunch72 brand ' . strtolower( $brand_id ) . '.' );
			return true;
		}
		if ( strtolower( $brand_id ) !== $p['brandId'] || strtolower( $destination_id ) !== $p['destinationId'] ) {
			return new WP_Error( 'r72_other_brand', 'This WordPress site is paired with a different Relaunch72 brand or website connection. Nothing was changed.', array( 'status' => 403 ) );
		}
		$p['lastCheckAt'] = gmdate( 'c' );
		update_option( self::OPT_PAIRING, $p, false );
		return true;
	}

	/** @return true|WP_Error */
	public static function assert_paired( $brand_id, $destination_id ) {
		$p = self::pairing();
		if ( empty( $p['brandId'] ) ) {
			return new WP_Error( 'r72_not_paired', 'Run the Relaunch72 connection check before publishing. Nothing was changed.', array( 'status' => 409 ) );
		}
		if ( ! is_string( $brand_id ) || ! is_string( $destination_id ) || strtolower( $brand_id ) !== $p['brandId'] || strtolower( $destination_id ) !== $p['destinationId'] ) {
			return new WP_Error( 'r72_other_brand', 'This article belongs to a different Relaunch72 brand or website connection. Nothing was changed.', array( 'status' => 403 ) );
		}
		return true;
	}

	// ─── Standalone site SEO controls ───────────────────────────────────────

	/** Standalone-mode site SEO settings. Templates use %title%, %sitename%, %tagline%, %sep%, %term%, %term_description%, %excerpt%, %page%, %search%. */
	public static function site_seo_defaults() {
		return array(
			'site_wide'         => false,
			'separator'         => '|',
			'title_home'        => '%sitename% %sep% %tagline%',
			'title_post'        => '%title% %sep% %sitename%',
			'title_page'        => '%title% %sep% %sitename%',
			'title_archive'     => '%title% %sep% %page% %sep% %sitename%',
			'title_search'      => '',
			'title_404'         => '',
			'desc_home'         => '%tagline%',
			'desc_archive'      => '%term_description%',
			'noindex_category'  => false,
			'noindex_tag'       => false,
			'noindex_author'    => false,
			'noindex_date'      => false,
			'noindex_search'    => false,
			'noindex_paged'     => false,
			'kg_type'           => '',
			'organization_name' => '',
			'logo_url'          => '',
			'social_profiles'   => array(),
			'og_default_image'  => '',
			'twitter_card'      => 'summary_large_image',
			'twitter_site'      => '',
			'article_schema'    => true,
			'core_sitemap'      => 'default',
		);
	}

	public static function site_seo() {
		$s = get_option( self::OPT_SITE_SEO, array() );
		return self::sanitize_site_seo( array_merge( self::site_seo_defaults(), is_array( $s ) ? $s : array() ) );
	}

	/** Field types drive both sanitisation and the settings form. */
	public static function site_seo_fields() {
		return array(
			'site_wide'         => 'bool',
			'separator'         => 'separator',
			'title_home'        => 'text',
			'title_post'        => 'text',
			'title_page'        => 'text',
			'title_archive'     => 'text',
			'title_search'      => 'text',
			'title_404'         => 'text',
			'desc_home'         => 'text',
			'desc_archive'      => 'text',
			'noindex_category'  => 'bool',
			'noindex_tag'       => 'bool',
			'noindex_author'    => 'bool',
			'noindex_date'      => 'bool',
			'noindex_search'    => 'bool',
			'noindex_paged'     => 'bool',
			'kg_type'           => 'kg_type',
			'organization_name' => 'text',
			'logo_url'          => 'url',
			'social_profiles'   => 'urls',
			'og_default_image'  => 'url',
			'twitter_card'      => 'twitter_card',
			'twitter_site'      => 'handle',
			'article_schema'    => 'bool',
			'core_sitemap'      => 'core_sitemap',
		);
	}

	public static function sanitize_site_seo( array $raw ) {
		$out = self::site_seo_defaults();
		foreach ( self::site_seo_fields() as $key => $type ) {
			if ( ! array_key_exists( $key, $raw ) ) {
				continue;
			}
			$v = $raw[ $key ];
			switch ( $type ) {
				case 'bool':
					$out[ $key ] = (bool) $v;
					break;
				case 'separator':
					$v           = trim( sanitize_text_field( (string) $v ) );
					$out[ $key ] = ( '' !== $v && mb_strlen( $v ) <= 3 ) ? $v : '|';
					break;
				case 'text':
					$out[ $key ] = mb_substr( sanitize_text_field( (string) $v ), 0, 300 );
					break;
				case 'url':
					$out[ $key ] = esc_url_raw( (string) $v, array( 'https', 'http' ) );
					break;
				case 'urls':
					$list = array();
					foreach ( is_array( $v ) ? $v : preg_split( '/
||
/', (string) $v ) as $line ) {
						$line = esc_url_raw( trim( (string) $line ), array( 'https', 'http' ) );
						if ( '' !== $line ) {
							$list[] = $line;
						}
					}
					$out[ $key ] = array_slice( array_values( array_unique( $list ) ), 0, 12 );
					break;
				case 'kg_type':
					$out[ $key ] = in_array( $v, array( '', 'organization', 'person' ), true ) ? $v : '';
					break;
				case 'twitter_card':
					$out[ $key ] = in_array( $v, array( 'summary', 'summary_large_image' ), true ) ? $v : 'summary_large_image';
					break;
				case 'handle':
					$v           = preg_replace( '/[^A-Za-z0-9_]/', '', (string) $v );
					$out[ $key ] = '' !== $v ? '@' . substr( $v, 0, 15 ) : '';
					break;
				case 'core_sitemap':
					$out[ $key ] = in_array( $v, array( 'default', 'on', 'off' ), true ) ? $v : 'default';
					break;
			}
		}
		return $out;
	}

	// ─── Audit (no secrets, bounded) ────────────────────────────────────────

	public static function audit( $kind, $message ) {
		$log   = get_option( self::OPT_AUDIT, array() );
		$log   = is_array( $log ) ? $log : array();
		$log[] = array(
			'at'      => gmdate( 'c' ),
			'kind'    => substr( sanitize_key( str_replace( '.', '_', $kind ) ), 0, 40 ),
			'message' => substr( wp_strip_all_tags( (string) $message ), 0, 300 ),
		);
		update_option( self::OPT_AUDIT, array_slice( $log, -50 ), false );
	}

	public static function audit_log() {
		$log = get_option( self::OPT_AUDIT, array() );
		return is_array( $log ) ? array_reverse( $log ) : array();
	}
}
